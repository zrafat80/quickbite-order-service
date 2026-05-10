declare namespace Express {
  interface Request {
    /** JWT payload decoded by JwtAuthGuard. */
    user?: {
      userId: number;
      role: string;
      email: string;
      restaurantId?: number;
      restaurantRole?: string;
      branchIds?: number[];
    };

    /** Per-request correlation id (set by CorrelationMiddleware). */
    correlationId?: string;

    /**
     * Resolved sharding region (set by RegionResolverMiddleware from the
     * `X-Region` header). `"all"` is allowed only for admin fan-out reads.
     */
    region?: string;
  }
}
