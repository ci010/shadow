import {
  inject,
  type InjectionKey,
  type Plugin,
  readonly,
  ref,
  type Ref,
} from 'vue'
import {
  DEFAULT_PRODUCT_FIXTURES,
  type ProductFixturesV1,
} from '../product-fixtures.ts'

type ProductFixturesRef = Readonly<Ref<ProductFixturesV1>>

const productFixturesKey: InjectionKey<ProductFixturesRef> = Symbol(
  'product-fixtures',
)

export function createProductFixturesProvider(
  fixtures: ProductFixturesV1 = DEFAULT_PRODUCT_FIXTURES,
): Plugin {
  return {
    install(app) {
      app.provide(productFixturesKey, readonly(ref(fixtures)))
    },
  }
}

export function useProductFixtures(): ProductFixturesRef {
  return inject(
    productFixturesKey,
    readonly(ref(DEFAULT_PRODUCT_FIXTURES)),
  )
}