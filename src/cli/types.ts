/**
 * Menu action enums for type-safe menu handling
 */

export enum MainMenuAction {
    Import = 'import',
    Export = 'export',
    ManageDbs = 'manage_dbs',
    Manage = 'manage',
    Settings = 'settings',
    Exit = 'exit',
}

export enum ConnectionMenuAction {
    Add = '__add__',
    AddFromUrl = '__add_from_url__',
    Back = '__back__',
}

export enum ConnectionItemAction {
    Edit = 'edit',
    UpdatePassword = 'update_password',
    Remove = 'remove',
    Back = 'back',
}

export enum DatabaseAction {
    Create = '__create__',
    Back = '__back__',
}

export enum DatabaseItemAction {
    Clone = 'clone',
    Rename = 'rename',
    Delete = 'delete',
    Back = 'back',
}

export enum SettingsMenuAction {
    ToggleVerbose = 'toggle_verbose',
    ExportConfig = 'export_config',
    ImportConfig = 'import_config',
    Back = 'back',
}

export enum LocaleMenuAction {
    Default = '__default__',
}
