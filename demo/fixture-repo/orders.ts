export interface Order {
  id: string;
  total: number;
  items: string[];
}

export function createOrder(items: string[]): Order {
  return { id: Math.random().toString(36).slice(2), total: items.length * 10, items };
}

export function applyDiscount(order: Order, percent: number): Order {
  return { ...order, total: order.total * (1 - percent / 100) };
}

export function cancelOrder(order: Order): void {
  console.log(`Order ${order.id} cancelled`);
}
