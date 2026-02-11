export class DbCliError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'DbCliError'
    }
}

export class ConnectionError extends DbCliError {
    constructor(message: string) {
        super(message)
        this.name = 'ConnectionError'
    }
}

export class ValidationError extends DbCliError {
    constructor(message: string) {
        super(message)
        this.name = 'ValidationError'
    }
}

export class AdapterError extends DbCliError {
    constructor(message: string) {
        super(message)
        this.name = 'AdapterError'
    }
}

export class ConfigError extends DbCliError {
    constructor(message: string) {
        super(message)
        this.name = 'ConfigError'
    }
}
