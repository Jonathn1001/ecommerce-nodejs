"use strict";

// * Unit tests for CheckoutService.placeOrder — the reservation / rollback
// * flow. All infrastructure deps (Mongo repos, Redis, discount service) are
// * factory-mocked, so this suite runs with only `jest` installed and never
// * touches a real database or Redis. checkoutPreview is spied per-test to
// * feed a canned set of products.

jest.mock("../../models/repositories/cart.repo", () => ({
  findCartById: jest.fn(),
  removeProductsFromCart: jest.fn(),
}));
jest.mock("../../models/repositories/order.repo", () => ({
  createOrder: jest.fn(),
}));
jest.mock("../../models/repositories/inventory.repo", () => ({
  releaseInventory: jest.fn(),
}));
jest.mock("../../models/repositories/product.repo", () => ({
  getValidCheckoutProducts: jest.fn(),
}));
jest.mock("../discount.service", () => ({
  getDiscountAmount: jest.fn(),
}));
jest.mock("../redis.service", () => ({
  acquireLock: jest.fn(),
  releaseLock: jest.fn(),
}));

const CheckoutService = require("../checkout.service");
const { createOrder } = require("../../models/repositories/order.repo");
const {
  releaseInventory,
} = require("../../models/repositories/inventory.repo");
const {
  removeProductsFromCart,
} = require("../../models/repositories/cart.repo");
const { acquireLock, releaseLock } = require("../redis.service");
const { BadRequestError } = require("../../utils/AppError");

const CART_ID = "cart-123";
const USER_ID = "user-1";
const PRODUCTS = [
  { product_id: "A", quantity: 1, price: 10 },
  { product_id: "B", quantity: 2, price: 5 },
];

// ? Bypass checkoutPreview (which needs cart/product/discount repos) and hand
// ? placeOrder a fixed order preview so the test targets the reservation flow.
function mockPreview(products = PRODUCTS) {
  jest.spyOn(CheckoutService, "checkoutPreview").mockResolvedValue({
    checkout_order: {
      totalPrice: 20,
      shippingFee: 0,
      totalDiscount: 0,
      totalCheckoutPrice: 20,
    },
    shop_order_ids_new: [{ item_products: products }],
  });
}

const placeArgs = () => ({
  cart_id: CART_ID,
  user_id: USER_ID,
  shop_order_ids: [],
});

beforeEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
});

describe("CheckoutService.placeOrder", () => {
  test("happy path: reserves all, creates order, clears cart by cart_id, no rollback", async () => {
    mockPreview();
    acquireLock.mockResolvedValue({ key: "k", token: "t" });
    releaseLock.mockResolvedValue(1);
    const order = { _id: "order-1" };
    createOrder.mockResolvedValue(order);
    removeProductsFromCart.mockResolvedValue({ modifiedCount: 1 });

    const result = await CheckoutService.placeOrder(placeArgs());

    expect(result).toBe(order);
    expect(acquireLock).toHaveBeenCalledTimes(2);
    expect(releaseLock).toHaveBeenCalledTimes(2);
    expect(releaseInventory).not.toHaveBeenCalled();
    // ? Cart cleared by cart_id in a single call, ids in order
    expect(removeProductsFromCart).toHaveBeenCalledTimes(1);
    expect(removeProductsFromCart).toHaveBeenCalledWith({
      cart_id: CART_ID,
      product_ids: ["A", "B"],
    });
  });

  test("partial reservation: 2nd product unavailable → rolls back only the 1st, throws, no order", async () => {
    mockPreview();
    acquireLock
      .mockResolvedValueOnce({ key: "kA", token: "tA" }) // A reserved
      .mockResolvedValueOnce(null); // B unavailable
    releaseLock.mockResolvedValue(1);
    releaseInventory.mockResolvedValue({ modifiedCount: 1 });

    await expect(CheckoutService.placeOrder(placeArgs())).rejects.toBeInstanceOf(
      BadRequestError
    );

    expect(releaseInventory).toHaveBeenCalledTimes(1);
    expect(releaseInventory).toHaveBeenCalledWith({
      product_id: "A",
      quantity: 1,
      cart_id: CART_ID,
    });
    expect(createOrder).not.toHaveBeenCalled();
    expect(removeProductsFromCart).not.toHaveBeenCalled();
  });

  test("order creation fails → rolls back ALL reservations, rethrows the original error, cart untouched", async () => {
    mockPreview();
    acquireLock.mockResolvedValue({ key: "k", token: "t" });
    releaseLock.mockResolvedValue(1);
    const boom = new Error("order write failed");
    createOrder.mockRejectedValue(boom);
    releaseInventory.mockResolvedValue({ modifiedCount: 1 });

    await expect(CheckoutService.placeOrder(placeArgs())).rejects.toBe(boom);

    expect(releaseInventory).toHaveBeenCalledTimes(2);
    expect(releaseInventory).toHaveBeenCalledWith({
      product_id: "A",
      quantity: 1,
      cart_id: CART_ID,
    });
    expect(releaseInventory).toHaveBeenCalledWith({
      product_id: "B",
      quantity: 2,
      cart_id: CART_ID,
    });
    expect(removeProductsFromCart).not.toHaveBeenCalled();
  });

  test("rollback resilience: a failing releaseInventory neither masks the original error nor skips the other compensation", async () => {
    mockPreview();
    acquireLock.mockResolvedValue({ key: "k", token: "t" });
    releaseLock.mockResolvedValue(1);
    const boom = new Error("order write failed");
    createOrder.mockRejectedValue(boom);
    // ? First compensation rejects, second succeeds
    releaseInventory
      .mockRejectedValueOnce(new Error("inventory store unavailable"))
      .mockResolvedValueOnce({ modifiedCount: 1 });

    // ? Original createOrder error propagates, not the rollback rejection
    await expect(CheckoutService.placeOrder(placeArgs())).rejects.toBe(boom);
    // ? Both compensations were attempted despite the first failing
    expect(releaseInventory).toHaveBeenCalledTimes(2);
  });
});
