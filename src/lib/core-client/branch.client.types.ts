export interface CoreBranchMetadata {
  id: number;
  restaurantId: number;
  restaurantStatus: string;
  restaurantName: string;
  countryCode: string;
  isActive: boolean;
  acceptOrders: boolean;
  deliveryFee: number;
  commission: number;
  currency: string;
  lat: number;
  lng: number;
  label: string;
  addressText: string;
}

export interface CoreBranchProduct {
  productId: number;
  name: string;
  imageUrl: string | null;
  price: number;
  stock: number;
  isAvailable: boolean;
}

export interface BranchStockItem {
  productId: number;
  quantity: number;
}

export interface ReserveStockResult {
  ok: boolean;
  reserved?: BranchStockItem[];
  insufficient?: Array<{
    productId: number;
    requested: number;
    available: number;
  }>;
}

export interface ReleaseStockResult {
  ok: boolean;
  released?: BranchStockItem[];
  missing?: number[];
}
