export function sendEmail(to: string, subject: string, body: string): void {
  console.log(`Emailing ${to}: ${subject}`);
}

export function sendSms(to: string, body: string): void {
  console.log(`Texting ${to}: ${body}`);
}

export function notifyOrderShipped(email: string, orderId: string): void {
  sendEmail(email, 'Your order shipped', `Order ${orderId} is on its way.`);
}
