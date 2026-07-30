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
