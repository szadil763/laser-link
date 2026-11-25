import { EventEmitter } from "node:events";
import { ReadlineParser, SerialPort } from "serialport";

export interface SerialLinkEvents {
  /** Uma linha recebida do GRBL, sem o fim de linha. */
  line: [string];
  /** A porta fechou (cabo desconectado, erro ou close()). */
  close: [];
  error: [Error];
}

/**
 * Canal serial com o GRBL. A implementação real usa `serialport`;
 * os testes e o modo simulador usam `FakeGrbl`.
 */
export interface SerialLink extends EventEmitter<SerialLinkEvents> {
  readonly isOpen: boolean;
  /** Abre a porta. Pode ser chamado de novo depois de um close. */
  open(): Promise<void>;
  close(): void;
  write(data: Buffer): void;
}

export class NodeSerialLink extends EventEmitter<SerialLinkEvents> implements SerialLink {
  private port: SerialPort | null = null;

  constructor(
    private readonly path: string,
    private readonly baudRate: number,
  ) {
    super();
  }

  get isOpen(): boolean {
    return this.port?.isOpen ?? false;
  }

  open(): Promise<void> {
    if (this.isOpen) return Promise.resolve();
    // Uma instância nova a cada abertura: reabrir após o cabo voltar é mais confiável assim.
    const port = new SerialPort({ path: this.path, baudRate: this.baudRate, autoOpen: false });
    const parser = port.pipe(new ReadlineParser({ delimiter: "\n" }));
    parser.on("data", (line: string) => this.emit("line", line.trim()));
    port.on("error", (err) => this.emit("error", err));
    port.on("close", () => {
      if (this.port === port) this.port = null;
      this.emit("close");
    });
    this.port = port;
    return new Promise((resolve, reject) => {
      port.open((err) => {
        if (err) {
          this.port = null;
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  close(): void {
    if (this.port?.isOpen) this.port.close();
  }

  write(data: Buffer): void {
    if (this.port?.isOpen) this.port.write(data);
  }
}
