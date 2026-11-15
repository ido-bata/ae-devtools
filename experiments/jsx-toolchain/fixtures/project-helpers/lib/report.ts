// Exercises bundler/transpiler helpers: enum IIFE lowering, class
// lowering (esbuild class syntax -> tsc ES5 functions), and a
// re-export chain (`export *`). The final JSX must still be ES3.
//
// NOTE: the sibling tsconfig.json sets useDefineForClassFields:false.
// With define semantics (the esbuild default), class fields compile to
// Object.defineProperty — an ES5 builtin absent from ExtendScript — and
// the output lint correctly rejects the artifact. Assignment semantics
// are what ES3 can actually run. Class *inheritance* is likewise
// rejected: tsc's __extends helper calls Object.setPrototypeOf /
// Object.create, both absent from the ES3 host.

export enum Kind {
  Alpha,
  Beta,
}

export class Reporter {
  label: string;
  constructor(label: string) {
    this.label = label;
  }
  describe(): string {
    return "report:" + this.label + ":" + Kind[this.kind()];
  }
  kind(): Kind {
    return Kind.Beta;
  }
}

export function makeReporter(label: string): Reporter {
  return new Reporter(label);
}
