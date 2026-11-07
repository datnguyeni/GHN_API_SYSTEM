import type {ComponentType} from "react";
export type ModuleRequest=<T>(path:string,init?:RequestInit)=>Promise<T>;
export type ModuleWorkspaceProps={view:string;isCeo?:boolean;isPlatformAdmin?:boolean;request:ModuleRequest;apiUrl:string;onNavigate:(view:string)=>void};
export type InstalledFrontendModule={key:string;views:readonly string[];Workspace:ComponentType<ModuleWorkspaceProps>;mobile?:{section:string;label:string;icon:string;preferred:string[]};bootstrap?:(request:ModuleRequest,hasView:(view:string)=>boolean)=>Promise<string|null>};
