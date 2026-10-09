export { BrowserAccounts, type BrowserAccountsProps } from "./browser-accounts";

// The bundle contract (doc 68 §16.2): the host loads `dist/index.mjs` and
// takes its DEFAULT export as the component. The named export stays for
// in-tree and test importers.
export { BrowserAccounts as default } from "./browser-accounts";
