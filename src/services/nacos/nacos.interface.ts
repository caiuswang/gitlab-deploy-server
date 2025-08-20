import { NacosContent } from "../../models"
export interface NacosService{
    getConfig() : NacosContent;
}