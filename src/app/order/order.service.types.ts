export interface AuthenticatedUser {
  userId: number;
  role: string;
  email?: string;
  restaurantId?: number;
  restaurantRole?: string;
  branchIds?: number[];
}
