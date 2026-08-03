// Three failures that need three different responses (spec §B3). Collapsing the third into a
// generic error is how a contract violation gets mistaken for an empty catalogue.
export class NetworkError extends Error {
  constructor(cause: unknown) {
    super("the gateway could not be reached");
    this.name = "NetworkError";
    this.cause = cause;
  }
}

export class HttpError extends Error {
  constructor(readonly status: number) {
    super(`the gateway answered ${status}`);
    this.name = "HttpError";
  }
}

export class SchemaMismatchError extends Error {
  constructor(
    readonly path: string,
    readonly detail: string
  ) {
    super(`response from ${path} did not match its contract: ${detail}`);
    this.name = "SchemaMismatchError";
  }
}
