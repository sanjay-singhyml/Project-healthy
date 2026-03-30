declare module "cli-table3" {
  export interface TableOptions {
    head?: string[];
    wordWrap?: boolean;
    colWidths?: number[];
  }

  export default class Table {
    constructor(options?: TableOptions);
    push(...rows: Array<Array<string>>): number;
    toString(): string;
  }
}
