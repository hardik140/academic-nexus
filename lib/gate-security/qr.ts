import QRCode from "qrcode";

/**
 * Rendering a payload to an image, server-side only.
 *
 * Server-side deliberately: the page ships an <svg>, not the credential
 * string and a client-side encoder. The raw payload therefore never appears
 * in the DOM, in a data attribute, in a React prop or in the RSC flight
 * stream — the only place it exists on the student's device is as the
 * geometry of the image itself.
 *
 * Error correction level M (about 15% recoverable) rather than the library
 * default: a gate pass is read off a phone screen at an angle in daylight,
 * with a fingerprint or two on the glass, and M is the level that survives
 * that without growing the symbol the way Q and H do.
 */
export async function qrSvg(payload: string): Promise<string> {
  return QRCode.toString(payload, {
    type: "svg",
    errorCorrectionLevel: "M",
    margin: 1,
    // Rendered into a sized container by the caller; the intrinsic width
    // only sets the aspect ratio.
    width: 320,
    color: { dark: "#000000", light: "#ffffff" },
  });
}
