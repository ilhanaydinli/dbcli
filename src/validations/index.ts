import { z } from 'zod'

export const RequiredStringSchema = z.string().min(1, 'This field is required')

export const DbNameSchema = z
    .string()
    .min(1, 'Name is required')
    .regex(
        /^[a-zA-Z0-9_-]+$/,
        'Invalid name. Only alphanumeric characters, underscores, and hyphens allowed.',
    )

export const PortSchema = z.coerce
    .number()
    .int('Port must be an integer')
    .min(1, 'Port must be valid')
    .max(65535, 'Port must be valid')

export const FilenameSchema = z
    .string()
    .min(1, 'Filename is required')
    .refine((val) => !val.includes('/') && !val.includes('\\'), {
        message:
            'Filename cannot contain path separators (/ or \\). Please use simple filenames only.',
    })
    .refine((val) => !/[<>:"|?*]/.test(val), {
        message: 'Filename contains invalid characters.',
    })

export const ConnectionNameSchema = z.string().min(1, 'Connection name is required')
export const HostSchema = z.string().min(1, 'Host is required')
export const DatabaseSchema = z.string().min(1, 'Database name is required')
export const UsernameSchema = z.string().min(1, 'Username is required')
export const PasswordRequiredSchema = z.string().min(1, 'Password is required')

export function zodValidate<T extends z.ZodSchema>(schema: T, value: unknown): string | undefined {
    const result = schema.safeParse(value)
    if (result.success) return undefined
    return result.error.issues[0]?.message || 'Invalid value'
}
