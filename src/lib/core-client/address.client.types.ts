export interface CoreCustomerAddress {
  id: number;
  userId: number;
  label: string;
  country: string;
  city: string;
  street: string;
  building: string | null;
  apartmentNumber: string | null;
  type: string;
  lat: number;
  lng: number;
}
