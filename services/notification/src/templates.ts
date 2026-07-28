import { ORDER_PLACED, ORDER_CONFIRMED, ORDER_CANCELLED } from "@ecom/contracts";

const MAP: Record<string, (o: { orderId: string }) => { subject: string; html: string }> =
  {
    [ORDER_PLACED]: ({ orderId }) => ({
      subject: `Order ${orderId} received`,
      html: `<p>We received your order <strong>${orderId}</strong>.</p>`,
    }),
    [ORDER_CONFIRMED]: ({ orderId }) => ({
      subject: `Order ${orderId} confirmed`,
      html: `<p>Your order <strong>${orderId}</strong> is confirmed.</p>`,
    }),
    [ORDER_CANCELLED]: ({ orderId }) => ({
      subject: `Order ${orderId} cancelled`,
      html: `<p>Your order <strong>${orderId}</strong> was cancelled.</p>`,
    }),
  };

// Throws rather than falling back to a generic body: an unmapped type means the
// dispatcher accepted an event it has no message for, which should surface loudly.
export function renderTemplate(
  type: string,
  o: { orderId: string }
): { subject: string; html: string } {
  const fn = MAP[type];
  if (!fn) throw new Error(`no_template:${type}`);
  return fn(o);
}
