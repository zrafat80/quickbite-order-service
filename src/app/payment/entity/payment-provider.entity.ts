export class PaymentProviderEntity {
  id!: number;
  name!: string;
  isEnabled!: boolean;
  priority!: number;

  constructor(data: Partial<PaymentProviderEntity>) {
    Object.assign(this, data);
  }
}
