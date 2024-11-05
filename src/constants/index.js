const ShopRoles = {
  SHOP_OWNER: "SHOP_OWNER",
  WRITER: "WRITER",
  ADMIN: "ADMIN",
};

const DISCOUNT_TYPES = {
  FIXED_AMOUNT: "fixed_amount",
  PERCENTAGE: "percentage",
};

const DISCOUNT_APPLIES_TO = {
  ALL_PRODUCTS: "all",
  SPECIFIC_PRODUCTS: "specific",
  CATEGORY: "category",
};

const ORDER_STATUSES = {
  PENDING: "pending",
  CONFIRMED: "confirmed",
  DELIVERED: "delivered",
  CANCELLED: "cancelled",
};

// ORDER-001 - Order created
// ORDER-002 - Order failed
// ORDER-003 - Order confirmed
// ORDER-004 - Order delivered
// ORDER-005 - Order cancelled
// PROMOTION-001 - Promotion created
// SHOP-001 - New Shop By User Followed
// PRODUCT-001 - New Product Created

const NOTIFICATION_TYPES = {
  ORDER_CREATED: "ORDER-001",
  ORDER_FAILED: "ORDER-002",
  ORDER_CONFIRMED: "ORDER-003",
  ORDER_DELIVERED: "ORDER-004",
  ORDER_CANCELLED: "ORDER-005",
  PROMOTION_CREATED: "PROMOTION-001",
  SHOP_FOLLOWED: "SHOP-001",
};

module.exports = {
  ShopRoles,
  DISCOUNT_APPLIES_TO,
  DISCOUNT_TYPES,
  ORDER_STATUSES,
  NOTIFICATION_TYPES,
};
