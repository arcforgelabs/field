// The catalogue items the retaining-wall engine prices with, by rate-card
// slot (see server/retaining-wall-rate-card.js for why the wall engine is
// code). Codes only, never prices: each item's rate is the catalogue's.
/**
 * The catalogue item behind each rate-card slot: the wall engine's bill of
 * materials and resources. This is the one place these codes are declared;
 * the required-code lists and the health page's references derive from it.
 */
export const WALL_RATE_CARD_ITEMS = Object.freeze({
  labourer: "LABOURER-HOUR",
  welder: "WELDER-HOUR",
  excavator: "EXCAVATOR-HOUR",
  kanga: "KANGA-HOUR",
  jackhammer: "JACKHAMMER-HOUR",
  vehicleHour: "VEHICLE-HOUR",
  vehicleKm: "VEHICLE-KM",
  sleeper: "SLEEPER-KENSINGTON",
  ibeam: "STEEL-IBEAM-125-GALV",
  cchannel: "STEEL-CCHANNEL-125-GALV",
  concreteBag: "CONCRETE-20KG-BAG",
  agpipe: "AGPIPE-BAY",
  fortacon: "FORTACON-BAY",
  gravel: "GRAVEL-20MM",
  bluestoneLarge: "BLUESTONE-LARGE",
  bluestoneSmall: "BLUESTONE-SMALL",
  apcDeliveryMinimum: "APC-DELIVERY-MINIMUM",
  siteAllowance: "SITE-ALLOWANCE-DAY",
  adminFee: "ADMIN-FEE",
});

/**
 * The same items by uid (#178 code retirement step 4): the production
 * catalogue items. The engine prices from maps keyed by each item's legacy
 * code, which never changes (item_code_aliases); health checks that each
 * uid still answers to the code beside it, and reports a slot found only by
 * code (an installation without these items, such as the synthetic
 * verification catalogue). APC-DELIVERY-MINIMUM has no production item.
 */
export const WALL_RATE_CARD_ITEM_UIDS = Object.freeze({
  labourer: "cat_d14c246b2d4e4a3db3a33039",
  welder: "cat_35aa40c3168f4d1d98a56bc7",
  excavator: "cat_8cb11ceea88e41159072f17e",
  kanga: "cat_2063217769084b9daafce748",
  jackhammer: "cat_b3cc449ea1f042379a35f346",
  vehicleHour: "cat_68707fe551034fe888269864",
  vehicleKm: "cat_ad791d52bd094b909e192f22",
  sleeper: "cat_96e9b0fa6da04f9084aab9ae",
  ibeam: "cat_5687166934da4cf298e71556",
  cchannel: "cat_a507820f2aed4e6895fe9558",
  concreteBag: "cat_73488a25031c47cf8d4b3ae7",
  agpipe: "cat_81030182e7fa4a1798b5ac56",
  fortacon: "cat_0a9cf32b74cc46a390579fb9",
  gravel: "cat_057c6fd0036247ca80ede800",
  bluestoneLarge: "cat_81fc30336acf4184955b743f",
  bluestoneSmall: "cat_6ae35b54e5054d93a65a6338",
  siteAllowance: "cat_411d8bf43eb94fc29c260140",
  adminFee: "cat_e0c1d03211434e06a105e7e2",
});

/** The declared uid for a wall item code, if it has one. */
export function wallItemUidForCode(code) {
  const slot = Object.keys(WALL_RATE_CARD_ITEMS).find((key) => WALL_RATE_CARD_ITEMS[key].toLowerCase() === String(code || "").trim().toLowerCase());
  return slot ? WALL_RATE_CARD_ITEM_UIDS[slot] || null : null;
}
