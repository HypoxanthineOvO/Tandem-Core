/** Deployment-owned header presentation is validated before Settings projects it. */
import { expect, it } from 'vitest'
import { Config } from '../src/index.ts'

it('supplies the deployed default and rejects an unknown presentation', () => {
  expect(Config({}).headerPresentation.get()).toBe('default')
  expect(Config({ headerPresentation: 'none' }).headerPresentation.get()).toBe('none')
  expect(() => Config(JSON.parse('{"headerPresentation":"hidden"}'))).toThrow()
})
