package vn.aicrm.sales;
import java.util.*;import org.springframework.stereotype.Component;import vn.coreplatform.kernel.*;import vn.aicrm.shared.*;
@Component
@org.springframework.core.annotation.Order(20)
public class SalesModule implements ModuleContributor,org.springframework.boot.ApplicationRunner {
 private final ResourceRegistry resources;
 public SalesModule(ResourceRegistry resources){this.resources=resources;}
 public void run(org.springframework.boot.ApplicationArguments args){BusinessModules.registerResources("aicrm-sales",resources);}
 public ModuleDescriptor descriptor(){return new ModuleDescriptor("aicrm-sales","Bán hàng","1.0.0",List.of("aicrm-retail","aicrm-stock","aicrm-partners","aicrm-accounting"),List.of("sales-operations"),"Bán hàng — gói nghiệp vụ",">=1.1.0 <2.0.0");}
 public List<NavigationWorkspaceDescriptor> navigationWorkspaces(){return RetailModule.allWorkspaces().stream().filter(w->Set.of("retail","retail-shipping").contains(w.key())).toList();}
 public List<NavigationItemDescriptor> navigationItems(){return RetailModule.allItems().stream().filter(i->BusinessModules.screenOwner(i.viewKey().substring(7)).equals("aicrm-sales")).toList();}
}
