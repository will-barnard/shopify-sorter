export const SHOP_INFO = /* GraphQL */ `
  query ShopInfo {
    shop {
      id
      name
      myshopifyDomain
      ianaTimezone
    }
  }
`;

export const LIST_COLLECTIONS = /* GraphQL */ `
  query ListCollections($cursor: String, $query: String) {
    collections(first: 50, after: $cursor, query: $query, sortKey: TITLE) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        title
        handle
        sortOrder
        productsCount {
          count
        }
      }
    }
  }
`;

export const COLLECTION_HEADER = /* GraphQL */ `
  query CollectionHeader($id: ID!) {
    collection(id: $id) {
      id
      title
      handle
      sortOrder
      productsCount {
        count
      }
    }
  }
`;

// COLLECTION_DEFAULT reflects the collection's configured sort order, which for
// a MANUAL collection is exactly the merchant-visible manual order.
export const COLLECTION_PRODUCTS = /* GraphQL */ `
  query CollectionProducts($id: ID!, $cursor: String) {
    collection(id: $id) {
      id
      title
      sortOrder
      products(first: 250, after: $cursor, sortKey: COLLECTION_DEFAULT) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
          title
          handle
          tags
          status
          totalInventory
          createdAt
          publishedAt
          featuredMedia {
            preview {
              image {
                url
              }
            }
          }
          priceRangeV2 {
            minVariantPrice {
              amount
              currencyCode
            }
          }
        }
      }
    }
  }
`;

export const COLLECTION_PRODUCTS_BY_SORT_KEY = /* GraphQL */ `
  query CollectionProductsSorted($id: ID!, $cursor: String, $sortKey: ProductCollectionSortKeys!, $reverse: Boolean!) {
    collection(id: $id) {
      products(first: 250, after: $cursor, sortKey: $sortKey, reverse: $reverse) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
        }
      }
    }
  }
`;

export const PRODUCT_TAGS = /* GraphQL */ `
  query ProductTags($cursor: String) {
    productTags(first: 250, after: $cursor) {
      edges {
        node
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

export const REORDER_PRODUCTS = /* GraphQL */ `
  mutation ReorderCollection($id: ID!, $moves: [MoveInput!]!) {
    collectionReorderProducts(id: $id, moves: $moves) {
      job {
        id
        done
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const JOB_STATUS = /* GraphQL */ `
  query JobStatus($id: ID!) {
    job(id: $id) {
      id
      done
    }
  }
`;

export const SET_SORT_ORDER = /* GraphQL */ `
  mutation SetSortOrder($input: CollectionInput!) {
    collectionUpdate(input: $input) {
      collection {
        id
        sortOrder
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const CREATE_WEBHOOK = /* GraphQL */ `
  mutation CreateWebhook($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
    webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) {
      webhookSubscription {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

// ---- Lead-time notice ------------------------------------------------------
// One fragment shared by every lookup so a webhook event costs a single call:
// inventory item -> variant -> product, with the variants and description the
// decision needs. 100 variants is Shopify's per-page cap; a product with more is
// skipped by the runner rather than judged on a partial view.
const LEAD_TIME_PRODUCT = /* GraphQL */ `
  fragment LeadTimeProduct on Product {
    id
    title
    status
    tags
    descriptionHtml
    variants(first: 100) {
      pageInfo {
        hasNextPage
      }
      nodes {
        id
        title
        inventoryQuantity
        inventoryPolicy
        inventoryItem {
          tracked
        }
      }
    }
  }
`;

export const LEAD_TIME_PRODUCT_BY_ITEM = /* GraphQL */ `
  query LeadTimeProductByInventoryItem($id: ID!) {
    inventoryItem(id: $id) {
      id
      variants(first: 1) {
        nodes {
          product {
            ...LeadTimeProduct
          }
        }
      }
    }
  }
  ${LEAD_TIME_PRODUCT}
`;

// InventoryItem.variant is deprecated in favour of .variants. The runner tries
// the new field first and only falls back to this on an undefined-field error,
// so an older pinned API version keeps working.
export const LEAD_TIME_PRODUCT_BY_ITEM_LEGACY = /* GraphQL */ `
  query LeadTimeProductByInventoryItemLegacy($id: ID!) {
    inventoryItem(id: $id) {
      id
      variant {
        product {
          ...LeadTimeProduct
        }
      }
    }
  }
  ${LEAD_TIME_PRODUCT}
`;

export const LEAD_TIME_PRODUCT_STATE = /* GraphQL */ `
  query LeadTimeProductState($id: ID!) {
    product(id: $id) {
      ...LeadTimeProduct
    }
  }
  ${LEAD_TIME_PRODUCT}
`;

export const LEAD_TIME_PRODUCTS_BY_TAG = /* GraphQL */ `
  query LeadTimeProductsByTag($cursor: String, $query: String!) {
    products(first: 100, after: $cursor, query: $query) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
      }
    }
  }
`;

export const LEAD_TIME_SET_DESCRIPTION = /* GraphQL */ `
  mutation LeadTimeSetDescription($product: ProductUpdateInput!) {
    productUpdate(product: $product) {
      product {
        id
        descriptionHtml
      }
      userErrors {
        field
        message
      }
    }
  }
`;
