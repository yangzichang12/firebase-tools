import { ChildProcess } from "child_process";
import { EventEmitter } from "events";
import * as path from "path";

export enum Emulators {
  FUNCTIONS = "functions",
  FIRESTORE = "firestore",
  DATABASE = "database",
  HOSTING = "hosting",
  PUBSUB = "pubsub",
}

export type JavaEmulators = Emulators.FIRESTORE | Emulators.DATABASE | Emulators.PUBSUB;

// TODO: Is there a way we can just allow iteration over the enum?
export const ALL_EMULATORS = [
  Emulators.FUNCTIONS,
  Emulators.FIRESTORE,
  Emulators.DATABASE,
  Emulators.HOSTING,
  Emulators.PUBSUB,
];

export const JAVA_EMULATORS = [Emulators.FIRESTORE, Emulators.DATABASE, Emulators.PUBSUB];

export function isJavaEmulator(value: string): value is JavaEmulators {
  if (isEmulator(value)) {
    return JAVA_EMULATORS.indexOf(value) >= 0;
  }

  return false;
}

export function isEmulator(value: string): value is Emulators {
  return Object.values(Emulators).indexOf(value) >= 0;
}

export interface EmulatorInstance {
  /**
   * Called to begin the emulator process.
   *
   * Note: you should almost always call EmulatorRegistry.start() instead of this method.
   */
  start(): Promise<void>;

  /**
   * Called to tell the emulator to connect to other running emulators.
   * This must be called after start().
   */
  connect(): Promise<void>;

  /**
   * Called to stop the emulator process.
   *
   * Note: you should almost always call EmulatorRegistry.stop() instead of this method.
   */
  stop(): Promise<void>;

  /**
   * Get the information about the running instance needed by the registry;
   */
  getInfo(): EmulatorInfo;

  /**
   * Get the name of the corresponding service.
   */
  getName(): Emulators;
}

export interface EmulatorInfo {
  host: string;
  port: number;
}

export interface JavaEmulatorCommand {
  binary: string;
  args: string[];
  optionalArgs: string[];
  joinArgs: boolean;
}

export interface JavaEmulatorOptions {
  cacheDir: string;
  remoteUrl: string;
  expectedSize: number;
  expectedChecksum: string;
  namePrefix: string;
}

export abstract class JavaEmulatorDetails {
  instance: ChildProcess | null = null;
  stdout: any | null = null;

  constructor(public name: string, public opts: JavaEmulatorOptions) {}

  abstract get downloadPath(): string;
  abstract get binaryPath(): string;
  abstract get unzipDir(): string | undefined;
}

export class JarEmulatorDetails extends JavaEmulatorDetails {
  constructor(name: string, private localPath: string, opts: JavaEmulatorOptions) {
    super(name, opts);
  }

  get downloadPath(): string {
    return this.localPath;
  }

  get binaryPath(): string {
    return this.localPath;
  }

  get unzipDir(): string | undefined {
    return undefined;
  }
}

export class ZipEmulatorDetails extends JavaEmulatorDetails {
  constructor(
    name: string,
    private localPath: string,
    private _unzipDir: string,
    private zipRelativePath: string,
    opts: JavaEmulatorOptions
  ) {
    super(name, opts);
  }

  get downloadPath(): string {
    return this.localPath;
  }

  get binaryPath(): string {
    return path.join(this._unzipDir, this.zipRelativePath);
  }

  get unzipDir(): string | undefined {
    return this._unzipDir;
  }
}

export interface Address {
  host: string;
  port: number;
}

export class EmulatorLog {
  get date(): Date {
    if (!this.timestamp) {
      return new Date(0);
    }
    return new Date(this.timestamp);
  }

  static waitForFlush(): Promise<void> {
    return new Promise((resolve) => {
      const interval = setInterval(() => {
        if (!EmulatorLog.WAITING_FOR_FLUSH) {
          resolve();
          clearInterval(interval);
        }
      }, 10);
    });
  }

  static waitForLog(
    emitter: EventEmitter,
    level: string,
    type: string,
    filter?: (el: EmulatorLog) => boolean
  ): Promise<EmulatorLog> {
    return new Promise((resolve, reject) => {
      const listener = (el: EmulatorLog) => {
        const levelTypeMatch = el.level === level && el.type === type;
        let filterMatch = true;
        if (filter) {
          filterMatch = filter(el);
        }

        if (levelTypeMatch && filterMatch) {
          emitter.removeListener("log", listener);
          resolve(el);
        }
      };
      emitter.on("log", listener);
    });
  }

  static fromJSON(json: string): EmulatorLog {
    let parsedLog;
    let isNotJSON = false;
    try {
      parsedLog = JSON.parse(json);
    } catch (err) {
      isNotJSON = true;
    }

    parsedLog = parsedLog || {};

    if (
      isNotJSON ||
      parsedLog.level === undefined ||
      parsedLog.type === undefined ||
      parsedLog.text === undefined
    ) {
      parsedLog = {
        level: "USER",
        text: json,
      };
    }

    return new EmulatorLog(
      parsedLog.level,
      parsedLog.type,
      parsedLog.text,
      parsedLog.data,
      parsedLog.timestamp
    );
  }

  private static WAITING_FOR_FLUSH = false;
  private static LOG_BUFFER: string[] = [];

  constructor(
    public level: "DEBUG" | "INFO" | "WARN" | "WARN_ONCE" | "ERROR" | "FATAL" | "SYSTEM" | "USER",
    public type: string,
    public text: string,
    public data?: any,
    public timestamp?: string
  ) {
    this.timestamp = this.timestamp || new Date().toString();
    this.data = this.data || {};
  }

  toString(): string {
    return this.toStringCore(false);
  }

  toPrettyString(): string {
    return this.toStringCore(true);
  }

  /**
   * We use a global boolean to know if all of our messages have been flushed, and the functions
   * emulator can wait on this variable to flip before exiting. This ensures that we never
   * miss a log message that has been queued but has not yet flushed.
   */
  log(): void {
    const msg = `${this.toString()}\n`;
    this.bufferMessage(msg);
    this.flush();
  }

  private bufferMessage(msg: string): void {
    EmulatorLog.LOG_BUFFER.push(msg);
  }

  private flush(): void {
    const nextMsg = EmulatorLog.LOG_BUFFER.shift();
    if (!nextMsg) {
      return;
    }

    EmulatorLog.WAITING_FOR_FLUSH = true;
    if (process.send) {
      // For some reason our node.d.ts file does not include the version of subprocess.send() with a callback
      // but the node docs assert that it has an optional callback.
      // https://nodejs.org/api/child_process.html#child_process_subprocess_send_message_sendhandle_options_callback
      (process.send as any)(nextMsg, undefined, {}, (err: any) => {
        if (err) {
          process.stderr.write(err);
        }

        EmulatorLog.WAITING_FOR_FLUSH = EmulatorLog.LOG_BUFFER.length > 0;
        this.flush();
      });
    } else {
      process.stderr.write(
        "subprocess.send() is undefined, cannot communicate with Functions Runtime."
      );
    }
  }

  private toStringCore(pretty = false): string {
    return JSON.stringify(
      {
        timestamp: this.timestamp,
        level: this.level,
        text: this.text,
        data: this.data,
        type: this.type,
      },
      undefined,
      pretty ? 2 : 0
    );
  }
}

/**
 * google.firebase.rules.v1.Issue
 */
export interface Issue {
  sourcePosition: SourcePosition;
  description: string;
  severity: Severity;
}

export enum Severity {
  SEVERITY_UNSPECIFIED = 0,
  DEPRECATION = 1,
  WARNING = 2,
  ERROR = 3,
}

export interface SourcePosition {
  fileName: string;
  fileIndex: number;
  line: number;
  column: number;
}
