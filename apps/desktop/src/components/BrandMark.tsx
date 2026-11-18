import mark from "../assets/keryx-mark.png";

/** The Keryx mark (the app icon); decorative, the name is always written next to it. */
export function BrandMark({ className }: { className: string }) {
  return <img className={className} src={mark} alt="" aria-hidden draggable={false} />;
}
