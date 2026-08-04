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

// Distinct from HttpError(401): this means "no usable session, and refreshing did not help",
// which is a routing decision (go to /login). A 401 from /auth/login itself is a rejected
// credential and stays an HttpError so the form can say so without redirecting.
export class UnauthenticatedError extends Error {
  constructor() {
    super("not signed in");
    this.name = "UnauthenticatedError";
  }
}
