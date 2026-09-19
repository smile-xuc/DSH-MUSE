import { logEvent } from './logger.mjs';

export function createOrder(orderId, amount, traceId = 'tr-order-1') {
  const res = logEvent('info', `order ${orderId} created amount=${amount}`);
  return { orderId, amount, status: 'created', log: res };
}
