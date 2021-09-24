import DynamicConfig from './DynamicConfig';
import LogEvent from './LogEvent';
import StatsigIdentity from './StatsigIdentity';
import StatsigLogger from './StatsigLogger';
import StatsigNetwork from './StatsigNetwork';
import StatsigSDKOptions, { StatsigOptions } from './StatsigSDKOptions';
import StatsigStore from './StatsigStore';
import { StatsigUser } from './StatsigUser';
import StatsigAsyncStorage from './utils/StatsigAsyncLocalStorage';
import type { AsyncStorage } from './utils/StatsigAsyncLocalStorage';
import type {
  NativeModules,
  Platform,
  DeviceInfo,
  ExpoConstants,
  ExpoDevice,
} from './StatsigIdentity';

const MAX_VALUE_SIZE = 64;
const MAX_OBJ_SIZE = 1024;

export type AppState = {
  currentState: AppStateStatus;
  addEventListener: (
    event: string,
    handler: (newState: string) => void,
  ) => void;
  removeEventListener: (
    event: string,
    handler: (newState: string) => void,
  ) => void;
};

export type AppStateStatus = string;

export type _SDKPackageInfo = {
  sdkType: string;
  sdkVersion: string;
};

export interface IHasStatsigInternal {
  getNetwork(): StatsigNetwork;
  getStore(): StatsigStore;
  getLogger(): StatsigLogger;
  getOptions(): StatsigSDKOptions;
  getCurrentUser(): object | null;
  getSDKKey(): string;
  getStatsigMetadata(): Record<string, string | number>;
}

export default class StatsigClient implements IHasStatsigInternal {
  // RN dependencies
  private appState: AppState | null = null;
  private currentAppState: AppStateStatus | null = null;

  private ready: boolean;
  private pendingInitPromise: Promise<void> | null = null;

  private network: StatsigNetwork;
  public getNetwork(): StatsigNetwork {
    return this.network;
  }

  private store: StatsigStore;
  public getStore(): StatsigStore {
    return this.store;
  }

  private logger: StatsigLogger;
  public getLogger(): StatsigLogger {
    return this.logger;
  }

  private options: StatsigSDKOptions;
  public getOptions(): StatsigSDKOptions {
    return this.options;
  }

  private sdkKey: string | null;
  public getSDKKey(): string {
    if (this.sdkKey == null) {
      return '';
    }
    return this.sdkKey;
  }

  private identity: StatsigIdentity;
  public getCurrentUser(): StatsigUser | null {
    return this.identity.getUser();
  }
  public getStatsigMetadata(): Record<string, string | number> {
    return this.identity.getStatsigMetadata();
  }

  public constructor() {
    this.ready = false;
    this.sdkKey = null;
    this.options = new StatsigSDKOptions();
    this.identity = new StatsigIdentity();
    this.network = new StatsigNetwork(this);
    this.store = new StatsigStore(this);
    this.logger = new StatsigLogger(this);
  }

  public async initializeAsync(
    sdkKey: string,
    user?: StatsigUser | null,
    options?: StatsigOptions | null,
  ): Promise<void> {
    if (this.pendingInitPromise != null) {
      return this.pendingInitPromise;
    }
    if (this.ready) {
      return Promise.resolve();
    }
    if (typeof sdkKey !== 'string' || !sdkKey.startsWith('client-')) {
      return Promise.reject(
        new Error(
          'Invalid key provided.  You must use a Client SDK Key from the Statsig console to initialize the sdk',
        ),
      );
    }
    this.sdkKey = sdkKey;
    this.options = new StatsigSDKOptions(options);
    this.identity.setUser(this.normalizeUser(user ?? null));
    this.logger.init();

    if (StatsigAsyncStorage.asyncStorage) {
      await this.identity.initAsync();
      await this.store.loadFromAsyncStorage();
    } else {
      this.identity.init();
      this.store.loadFromLocalStorage();
    }

    if (this.appState) {
      this.currentAppState = this.appState.currentState;
      this.appState.addEventListener('change', this.handleAppStateChange);
    }

    this.pendingInitPromise = this.network
      .fetchValues(
        this.identity.getUser(),
        async (json: Record<string, any>): Promise<void> => {
          await this.store.save(json);
          return;
        },
        (e: Error) => {},
      )
      .finally(async () => {
        this.pendingInitPromise = null;
        this.ready = true;
        this.logger.sendSavedRequests();
      });
    return this.pendingInitPromise;
  }

  /**
   * Checks the value of a gate for the current user
   * @param {string} gateName - the name of the gate to check
   * @returns {boolean} - value of a gate for the user. Gates are "off" (return false) by default
   * @throws Error if initialize() is not called first, or gateName is not a string
   */
  public checkGate(gateName: string): boolean {
    if (!this.ready) {
      throw new Error('Call and wait for initialize() to finish first.');
    }
    if (typeof gateName !== 'string' || gateName.length === 0) {
      throw new Error('Must pass a valid string as the gateName.');
    }
    return this.store.checkGate(gateName);
  }

  /**
   * Checks the value of a config for the current user
   * @param {string} configName - the name of the config to get
   * @returns {DynamicConfig} - value of a config for the user
   * @throws Error if initialize() is not called first, or configName is not a string
   */
  public getConfig(configName: string): DynamicConfig {
    if (!this.ready) {
      throw new Error('Call and wait for initialize() to finish first.');
    }
    if (typeof configName !== 'string' || configName.length === 0) {
      throw new Error('Must pass a valid string as the configName.');
    }

    return this.store.getConfig(configName);
  }

  /**
   * Gets the experiment for a given user
   * @param {string} experimentName - the name of the experiment to get
   * @returns {DynamicConfig} - value of the experiment for the user, represented by a Dynamic Config object
   * @throws Error if initialize() is not called first, or experimentName is not a string
   */
  public getExperiment(experimentName: string): DynamicConfig {
    if (!this.ready) {
      throw new Error('Call and wait for initialize() to finish first.');
    }
    if (typeof experimentName !== 'string' || experimentName.length === 0) {
      throw new Error('Must pass a valid string as the experimentName.');
    }
    return this.store.getConfig(experimentName);
  }

  public logEvent(
    eventName: string,
    value: string | number | null = null,
    metadata: Record<string, string> | null = null,
  ): void {
    if (!this.logger || !this.sdkKey) {
      throw new Error('Must initialize() before logging events.');
    }
    if (typeof eventName !== 'string' || eventName.length === 0) {
      console.error('Event not logged. No valid eventName passed.');
      return;
    }
    if (this.shouldTrimParam(eventName, MAX_VALUE_SIZE)) {
      console.warn(
        'eventName is too long, trimming to ' + MAX_VALUE_SIZE + ' characters.',
      );
      eventName = eventName.substring(0, MAX_VALUE_SIZE);
    }
    if (
      typeof value === 'string' &&
      this.shouldTrimParam(value, MAX_VALUE_SIZE)
    ) {
      console.warn('value is too long, trimming to ' + MAX_VALUE_SIZE + '.');
      value = value.substring(0, MAX_VALUE_SIZE);
    }
    if (this.shouldTrimParam(metadata, MAX_OBJ_SIZE)) {
      console.warn('metadata is too big. Dropping the metadata.');
      metadata = { error: 'not logged due to size too large' };
    }
    const event = new LogEvent(eventName);
    event.setValue(value);
    event.setMetadata(metadata);
    event.setUser(this.getCurrentUser());
    this.logger.log(event);
  }

  public updateUser(user: StatsigUser | null): Promise<boolean> {
    if (!this.ready) {
      throw new Error('Call and wait for initialize() to finish first.');
    }
    this.identity.updateUser(this.normalizeUser(user));
    this.pendingInitPromise = this.network
      .fetchValues(
        this.identity.getUser(),
        async (json: Record<string, any>): Promise<void> => {
          await this.store.save(json);
        },
        (e: Error) => {
          throw e;
        },
      )
      .finally(() => {
        this.pendingInitPromise = null;
        this.ready = true;
      });
    return this.pendingInitPromise
      .then(() => {
        return Promise.resolve(true);
      })
      .catch(() => {
        return Promise.resolve(false);
      });
  }

  /**
   * Informs the statsig SDK that the client is closing or shutting down
   * so the SDK can clean up internal state
   */
  public shutdown(): void {
    this.logger.flush(true);
    if (this.appState) {
      this.appState.removeEventListener('change', this.handleAppStateChange);
    }
  }

  public overrideGate(gateName: string, value: boolean): void {
    this.store.overrideGate(gateName, value);
  }

  public removeOverride(name?: string): void {
    this.store.removeOverride(name);
  }

  public getOverrides(): Record<string, any> {
    return this.store.getOverrides();
  }

  public setSDKPackageInfo(sdkPackageInfo: _SDKPackageInfo) {
    this.identity.setSDKPackageInfo(sdkPackageInfo);
  }

  public setAsyncStorage(asyncStorage: AsyncStorage): void {
    StatsigAsyncStorage.asyncStorage = asyncStorage;
  }

  public setAppState(appState: AppState): void {
    this.appState = appState;
  }

  public setNativeModules(nativeModules: NativeModules): void {
    this.identity.setNativeModules(nativeModules);
  }

  public setPlatform(platform: Platform): void {
    this.identity.setPlatform(platform);
  }

  public setRNDeviceInfo(deviceInfo: DeviceInfo): void {
    this.identity.setRNDeviceInfo(deviceInfo);
  }

  public setExpoConstants(expoConstants: ExpoConstants): void {
    this.identity.setExpoConstants(expoConstants);
  }

  public setExpoDevice(expoDevice: ExpoDevice): void {
    this.identity.setExpoDevice(expoDevice);
  }

  private handleAppStateChange(nextAppState: AppStateStatus): void {
    if (
      this.currentAppState === 'active' &&
      nextAppState.match(/inactive|background/)
    ) {
      this.logger.flush(true);
    } else if (
      this.currentAppState?.match(/inactive|background/) &&
      nextAppState === 'active'
    ) {
      this.logger.sendSavedRequests();
    }
    this.currentAppState = nextAppState;
  }

  private shouldTrimParam(
    entity: string | number | object | null,
    size: number,
  ): boolean {
    if (entity == null) return false;
    if (typeof entity === 'string') return entity.length > size;
    if (typeof entity === 'object') {
      return JSON.stringify(entity).length > size;
    }
    if (typeof entity === 'number') return entity.toString().length > size;
    return false;
  }

  private normalizeUser(user: StatsigUser | null): StatsigUser {
    user = this.trimUserObjIfNeeded(user);
    if (this.options.getEnvironment() != null) {
      // @ts-ignore
      user.statsigEnvironment = this.options.getEnvironment();
    }
    return user;
  }

  private trimUserObjIfNeeded(user: StatsigUser | null): StatsigUser {
    if (user == null) {
      return {};
    }
    if (this.shouldTrimParam(user.userID ?? null, MAX_VALUE_SIZE)) {
      console.warn(
        'User ID is too large, trimming to ' + MAX_VALUE_SIZE + 'characters',
      );
      user.userID = user.userID?.toString().substring(0, MAX_VALUE_SIZE);
    }
    if (this.shouldTrimParam(user, MAX_OBJ_SIZE)) {
      user.custom = {};
      if (this.shouldTrimParam(user, MAX_OBJ_SIZE)) {
        console.warn('User object is too large, only keeping the user ID.');
        user = { userID: user.userID };
      } else {
        console.warn('User object is too large, dropping the custom property.');
      }
    }
    return user;
  }
}