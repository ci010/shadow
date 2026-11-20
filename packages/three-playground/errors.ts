export type PlaygroundPhase = 'snapshot' | 'runtime' | 'build' | 'export' | 'validation' | 'limit';

export class PlaygroundError extends Error {
  readonly phase: PlaygroundPhase;
  readonly guestStack?: string;

  constructor(phase: PlaygroundPhase, message: string, guestStack?: string) {
    super(`[${phase}] ${message}`);
    this.name = 'PlaygroundError';
    this.phase = phase;
    this.guestStack = guestStack;
  }
}
