import { describe, expect, it } from 'bun:test'

import { runWizard } from '@/cli/wizard'

describe('runWizard', () => {
    it('should complete when every step succeeds', async () => {
        const visited: string[] = []
        const completed = await runWizard([
            async () => {
                visited.push('a')
                return true
            },
            async () => {
                visited.push('b')
                return true
            },
        ])

        expect(completed).toBe(true)
        expect(visited).toEqual(['a', 'b'])
    })

    it('should repeat the previous step when a step goes back', async () => {
        const visited: string[] = []
        let secondStepBacked = false

        const completed = await runWizard([
            async () => {
                visited.push('a')
                return true
            },
            async () => {
                visited.push('b')
                if (secondStepBacked) return true
                secondStepBacked = true
                return false
            },
        ])

        expect(completed).toBe(true)
        expect(visited).toEqual(['a', 'b', 'a', 'b'])
    })

    it('should abandon the wizard when the first step goes back', async () => {
        const visited: string[] = []

        const completed = await runWizard([
            async () => {
                visited.push('a')
                return false
            },
            async () => {
                visited.push('b')
                return true
            },
        ])

        expect(completed).toBe(false)
        expect(visited).toEqual(['a'])
    })

    it('should return to the immediately preceding step, not to the start', async () => {
        const visited: string[] = []
        let thirdStepBacked = false

        const completed = await runWizard([
            async () => {
                visited.push('a')
                return true
            },
            async () => {
                visited.push('b')
                return true
            },
            async () => {
                visited.push('c')
                if (thirdStepBacked) return true
                thirdStepBacked = true
                return false
            },
        ])

        expect(completed).toBe(true)
        expect(visited).toEqual(['a', 'b', 'c', 'b', 'c'])
    })

    it('should treat an empty wizard as completed', async () => {
        expect(await runWizard([])).toBe(true)
    })

    it('should pass over a skipped step when moving forward', async () => {
        const visited: string[] = []

        const completed = await runWizard([
            async () => {
                visited.push('a')
                return true
            },
            async () => {
                visited.push('skipped')
                return 'skip'
            },
            async () => {
                visited.push('c')
                return true
            },
        ])

        expect(completed).toBe(true)
        expect(visited).toEqual(['a', 'skipped', 'c'])
    })

    it('should pass over a skipped step when going back', async () => {
        const visited: string[] = []
        let lastStepBacked = false

        const completed = await runWizard([
            async () => {
                visited.push('a')
                return true
            },
            async () => {
                visited.push('skipped')
                return 'skip'
            },
            async () => {
                visited.push('c')
                if (lastStepBacked) return true
                lastStepBacked = true
                return false
            },
        ])

        expect(completed).toBe(true)
        expect(visited).toEqual(['a', 'skipped', 'c', 'skipped', 'a', 'skipped', 'c'])
    })

    it('should abandon the wizard when going back through a leading skipped step', async () => {
        const visited: string[] = []

        const completed = await runWizard([
            async () => {
                visited.push('skipped')
                return 'skip'
            },
            async () => {
                visited.push('b')
                return false
            },
        ])

        expect(completed).toBe(false)
        expect(visited).toEqual(['skipped', 'b', 'skipped'])
    })
})
