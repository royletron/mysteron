import { render } from "preact";
import { App } from "./App";
import logoUrl from "../images/m.png";
import "@fontsource-variable/geist"; // Geist (variable) — used for titles
import "./styles.css";

// Favicon = the Mysteron mark, matching the header logo.
function setFavicon(): void {
  const link = (document.querySelector("link[rel=icon]") as HTMLLinkElement) ?? document.createElement("link");
  link.rel = "icon";
  link.type = "image/png";
  link.href = logoUrl;
  document.head.appendChild(link);
}
setFavicon();

render(<App />, document.getElementById("app")!);
