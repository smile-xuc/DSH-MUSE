import { logEvent } from './logger.mjs';

export function processPayment(orderId, success, traceId = 'tr-pay-1') {
  if (success) {
    const res = logEvent('info', `payment success for order ${orderId}`);
    return { success: true, log: res };
  }
  const res = logEvent('error', `payment failed for order ${orderId}`);
  return { success: false, log: res };
}
