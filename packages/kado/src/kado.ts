interface Class {
  new (...args: any[]): unknown;
}
export type KadoToken = string | symbol | number;
export type KadoScope = 'Transient' | 'Singleton';
export interface KadoPromiseConstructor
  extends PromiseConstructorLike {
  all<T extends readonly unknown[] | []>(
    values: T,
  ): PromiseLike<{
    -readonly [P in keyof T]: Awaited<T[P]>;
  }>;
  resolve<T>(value: T): PromiseLike<Awaited<T>>;
}
export interface KadoManifestItem {
  token?: KadoToken;
  useClass?: Class;
  useValue?: any;
  useFnByContainer?(container: KadoContainer): any;
  useFn?(...args: any[]): any;
  params?: KadoParam[];
  scope?: KadoScope;
  meta?: Record<string, any>;
}
export type KadoParam = KadoToken | KadoManifestItem;
interface KadoContainerItem {
  manifestItem: KadoManifestItem;
  checkedForCircularDep: boolean;
  instance: null | PromiseLike<any>;
}
type KadoTokenToContainerItem = Map<
  KadoToken,
  KadoContainerItem
>;
export type KadoContainer = Container;

/**
 * Error conditions that may be met when resolving a request
 */
export type KadoErrorReason =
  | 'NotFound'
  | 'CircularDependencyDetected';
/**
 * Creates `Error`s to throw that may occur when resolving (conforms to `@daisugi/ayamari`)
 */
export type KadoErrorFactory = Record<
  KadoErrorReason,
  (msg: string) => Error
>;
/**
 * Required dependencies for Kado to work
 */
export interface KadoConfig {
  /**
   * Creates `Error`s to throw on error conditions (conforms to `@daisugi/ayamari`)
   */
  errFn: KadoErrorFactory;
  /**
   * Generates tokens for anonymous registrations (conforms to `@daisugi/kintsugi`)
   */
  urandom: () => KadoToken;
  /**
   * Promise constructor to specify custom implementation. Defaults to the global `Promise`.
   */
  promise?: KadoPromiseConstructor;
}

export class Container {
  #tokenToContainerItem: KadoTokenToContainerItem;
  #errFn: KadoErrorFactory;
  #urandom: () => KadoToken;
  #promise: KadoPromiseConstructor;

  constructor(config: KadoConfig) {
    this.#tokenToContainerItem = new Map();
    this.#errFn = config.errFn;
    this.#urandom = config.urandom;
    this.#promise = config.promise ?? Promise;
  }

  resolve<T>(token: KadoToken): PromiseLike<T> {
    const containerItem =
      this.#tokenToContainerItem.get(token);
    if (containerItem === undefined) {
      throw this.#errFn.NotFound(
        `Attempted to resolve unregistered dependency token: "${token.toString()}".`,
      );
    }
    const manifestItem = containerItem.manifestItem;
    if (manifestItem.useValue !== undefined) {
      return manifestItem.useValue;
    }
    if (containerItem.instance) {
      return containerItem.instance;
    }
    const promise = this.#promise;
    let resolve: ((value: any) => void) | undefined;
    if (manifestItem.scope !== Kado.scope.Transient) {
      containerItem.instance = new promise((_resolve) => {
        resolve = _resolve;
      });
    }
    let paramsPromise: PromiseLike<unknown[]> | undefined;
    if (manifestItem.params) {
      this.#checkForCircularDep(containerItem);
      paramsPromise = promise.all(
        manifestItem.params.map(
          this.#resolveParam.bind(this),
        ),
      );
    }
    let instance: PromiseLike<T>;
    if (manifestItem.useFn) {
      const fn = manifestItem.useFn;
      instance = paramsPromise
        ? paramsPromise.then((args) => fn(...args) as T)
        : promise.resolve(fn() as T);
    } else if (manifestItem.useFnByContainer) {
      instance = promise.resolve(
        manifestItem.useFnByContainer(this) as T,
      );
    } else if (manifestItem.useClass) {
      const ctor = manifestItem.useClass;
      instance = paramsPromise
        ? paramsPromise.then(
            (args) => new ctor(...args) as T,
          )
        : promise.resolve(new ctor() as T);
    } else {
      throw this.#errFn.NotFound(
        `No instantiation strategy found for token: "${token.toString()}".`,
      );
    }
    if (manifestItem.scope === Kado.scope.Transient) {
      return instance;
    }
    return instance.then(resolve).then((_) => instance);
  }

  #resolveParam(param: KadoParam) {
    const token =
      typeof param === 'object'
        ? this.#registerItem(param)
        : param;
    return this.resolve(token);
  }

  register(manifestItems: KadoManifestItem[]) {
    for (const manifestItem of manifestItems) {
      this.#registerItem(manifestItem);
    }
  }

  #registerItem(manifestItem: KadoManifestItem): KadoToken {
    const token = manifestItem.token || this.#urandom();
    this.#tokenToContainerItem.set(token, {
      manifestItem: Object.assign(manifestItem, { token }),
      checkedForCircularDep: false,
      instance: null,
    });
    return token;
  }

  list(): KadoManifestItem[] {
    return Array.from(
      this.#tokenToContainerItem.values(),
    ).map((containerItem) => containerItem.manifestItem);
  }

  get(token: KadoToken): KadoManifestItem {
    const containerItem =
      this.#tokenToContainerItem.get(token);
    if (containerItem === undefined) {
      throw this.#errFn.NotFound(
        `Attempted to get unregistered dependency token: "${token.toString()}".`,
      );
    }
    return containerItem.manifestItem;
  }

  #checkForCircularDep(
    containerItem: KadoContainerItem,
    tokens: KadoToken[] = [],
  ) {
    if (containerItem.checkedForCircularDep) {
      return;
    }
    const token = containerItem.manifestItem.token;
    if (!token) {
      return;
    }
    if (tokens.includes(token)) {
      const chainOfTokens = tokens
        .map((token) => `"${token.toString()}"`)
        .join(' ➡️ ');
      throw this.#errFn.CircularDependencyDetected(
        `Attempted to resolve circular dependency: ${chainOfTokens} 🔄 "${token.toString()}".`,
      );
    }
    if (containerItem.manifestItem.params) {
      for (const param of containerItem.manifestItem
        .params) {
        if (typeof param === 'object') {
          continue;
        }
        const paramContainerItem =
          this.#tokenToContainerItem.get(param);
        if (!paramContainerItem) {
          continue;
        }
        this.#checkForCircularDep(paramContainerItem, [
          ...tokens,
          token,
        ]);
        paramContainerItem.checkedForCircularDep = true;
      }
    }
  }
}

export class Kado {
  static scope: Record<KadoScope, KadoScope> = {
    Transient: 'Transient',
    Singleton: 'Singleton',
  };
  container: KadoContainer;

  constructor(config: KadoConfig) {
    this.container = new Container(config);
  }

  static value(value: unknown): KadoManifestItem {
    return { useValue: value };
  }

  static map(params: KadoParam[]): KadoManifestItem {
    return {
      useFn(...args: unknown[]) {
        return args;
      },
      params,
    };
  }

  static flatMap(params: KadoParam[]): KadoManifestItem {
    return {
      useFn(...args: unknown[]) {
        return args.flat();
      },
      params,
    };
  }
}
