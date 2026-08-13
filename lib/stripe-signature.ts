export async function verifyStripeWebhookSignature(
  body: string,
  header: string,
  secret: string,
  nowMs = Date.now(),
): Promise<boolean> {
  const parts = header.split(",").map((part) => part.trim().split("=", 2));
  const timestamp = parts.find(([key]) => key === "t")?.[1];
  const signatures = parts
    .filter(([key]) => key === "v1")
    .map(([, value]) => value)
    .filter(Boolean);

  if (
    !timestamp
    || !/^\d{1,16}$/.test(timestamp)
    || signatures.length === 0
    || Math.abs(nowMs / 1_000 - Number(timestamp)) > 300
  ) {
    return false;
  }

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${timestamp}.${body}`),
    ),
  );
  const expected = Array.from(digest)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

  return signatures.some((signature) => timingSafeEqual(signature, expected));
}

function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}
