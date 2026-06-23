import { render } from "preact";
import Boring from "boring-avatars";
import { App } from "./App";
import { COLORS } from "./Avatar";
import "./styles.css";

// Use the same marble boring-avatar as the favicon, so it matches the header mark.
function setFavicon(): void {
  const holder = document.createElement("div");
  render(<Boring size={64} name="Henson" variant="marble" colors={COLORS} />, holder);
  const svg = holder.innerHTML;
  if (!svg) return;
  const link = (document.querySelector("link[rel=icon]") as HTMLLinkElement) ?? document.createElement("link");
  link.rel = "icon";
  link.href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  document.head.appendChild(link);
}
setFavicon();

render(<App />, document.getElementById("app")!);
