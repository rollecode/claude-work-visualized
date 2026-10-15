export type PrismToken = { type: string; alias?: string | string[]; content: PrismStream }
export type PrismStream = string | PrismToken | Array<string | PrismToken>

declare const Prism: {
  languages: Record<string, object | undefined>
  tokenize: (text: string, grammar: object) => Array<string | PrismToken>
}
export default Prism
