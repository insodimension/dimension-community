// The ONLY module that names the asset file. `?inline` makes vite emit the file's bytes as a base64 data URL
// in the bundle; bun (tests) never imports this file.
import headUrl from "../../assets/head-f01.bin?inline";

export default headUrl;
