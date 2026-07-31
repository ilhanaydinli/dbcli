type WizardStepResult = boolean | 'skip'
export type WizardStep = () => Promise<WizardStepResult>

export async function runWizard(steps: WizardStep[]): Promise<boolean> {
    let index = 0
    let goingBack = false

    while (index < steps.length) {
        const step = steps[index] as WizardStep
        const result = await step()

        if (result === 'skip') {
            if (!goingBack) {
                index++
                continue
            }
            if (index === 0) return false
            index--
            continue
        }

        if (result) {
            goingBack = false
            index++
            continue
        }

        if (index === 0) return false
        goingBack = true
        index--
    }

    return true
}
