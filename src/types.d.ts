// rrweb-cssom (a CSSOM parser, also used by jsdom) ships no type declarations
declare module "rrweb-cssom" {
  export function parse(text: string): { cssRules: ArrayLike<any> };
}
