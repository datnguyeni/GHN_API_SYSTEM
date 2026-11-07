"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ModuleWorkspaceProps } from "../../module-contract";
import GhnOrders from "./ghn-orders";
import "./ghn-shipping-workspace.css";

type Row = Record<string, unknown>;
type Account = { account_id:string; name:string; environment:string; account_active:boolean; shop_record_id:string; shop_id:number; shop_name:string; branch_id:string; branch_name:string; warehouse_id:string; warehouse_name:string; sender_snapshot:string; return_snapshot:string; is_default:boolean; shop_active:boolean; token_configured:boolean };
type GhnLocation={_id:number;name:string;extensionNames:string[];type:string;parentId:number;status:number};
type Catalog = { branches:Row[]; warehouses:Row[] };
type GhnData = Catalog & { accounts:Account[] };
type ShopDetails = Row;
const text=(row:Row,key:string)=>String(row[key]??"");
const parseAddress=(value:string)=>{try{return JSON.parse(value) as Row;}catch{return {};}};
const blank=()=>({name:"",environment:"PRODUCTION",token:"",shopId:"",shopName:"",branchId:"",warehouseId:"",senderName:"",senderPhone:"",senderAddress:"",senderProvinceId:"",senderProvinceName:"",senderWardId:"",senderWardName:"",returnName:"",returnPhone:"",returnAddress:"",returnProvinceId:"",returnProvinceName:"",returnWardId:"",returnWardName:"",defaultServiceTypeId:"",defaultPaymentTypeId:"2",defaultRequiredNote:"CHOXEMHANGKHONGTHU",isDefault:false});

export default function GhnShippingWorkspace({request,isCeo,isPlatformAdmin,apiUrl,onNavigate}:ModuleWorkspaceProps){
  const canManage=!!isCeo||!!isPlatformAdmin;
  const [tab,setTab]=useState("orders");
  const [webhook,setWebhook]=useState<{path:string;headerName:string;secret:string}|null>(null);
  const [rows,setRows]=useState<Account[]>([]);
  const [catalog,setCatalog]=useState<Catalog>({branches:[],warehouses:[]});
  const [provinces,setProvinces]=useState<GhnLocation[]>([]),[senderWards,setSenderWards]=useState<GhnLocation[]>([]),[returnWards,setReturnWards]=useState<GhnLocation[]>([]);
  const [form,setForm]=useState(blank);
  const [editing,setEditing]=useState<Account|null>(null);
  const [shopDetails,setShopDetails]=useState<ShopDetails|null>(null),[detailsLoading,setDetailsLoading]=useState(false);
  const [loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(""),[notice,setNotice]=useState("");
  const warehouses=useMemo(()=>catalog.warehouses.filter(w=>!form.branchId||text(w,"branch_id")===form.branchId),[catalog.warehouses,form.branchId]);
  const load=useCallback(async()=>{
    if(!canManage){setLoading(false);return;}
    setLoading(true);setError("");
    try{const data=await request<GhnData>("/api/v1/retail/shipping/ghn/accounts");setRows(data.accounts);setCatalog({branches:data.branches,warehouses:data.warehouses});}
    catch(e){setError(e instanceof Error?e.message:"Không tải được cấu hình giao hàng.");}
    finally{setLoading(false);}
  },[request,canManage]);
  useEffect(()=>{void load();},[load]);
  useEffect(()=>{
    if(!editing){setProvinces([]);setSenderWards([]);setReturnWards([]);return;}
    const path=`/api/v1/retail/shipping/ghn/accounts/${editing.account_id}/shops/${editing.shop_record_id}/provinces`;
    request<GhnLocation[]>(path).then(setProvinces).catch(e=>setError(e instanceof Error?e.message:"Không tải được danh mục tỉnh/thành GHN."));
  },[editing?.account_id,editing?.shop_record_id,request]);
  useEffect(()=>{
    if(!editing||!provinces.length)return;
    const sender=parseAddress(editing.sender_snapshot),ret=parseAddress(editing.return_snapshot);
    const base=`/api/v1/retail/shipping/ghn/accounts/${editing.account_id}/shops/${editing.shop_record_id}/provinces`;
    if(sender.provinceId)request<GhnLocation[]>(`${base}/${sender.provinceId}/wards`).then(setSenderWards).catch(()=>setSenderWards([]));
    if(ret.provinceId)request<GhnLocation[]>(`${base}/${ret.provinceId}/wards`).then(setReturnWards).catch(()=>setReturnWards([]));
  },[editing?.account_id,editing?.shop_record_id,provinces,request]);
  const set=(key:keyof ReturnType<typeof blank>,value:string|boolean)=>setForm(old=>({...old,[key]:value,...(key==="branchId"?{warehouseId:""}:{})}));
  const selectProvince=async(side:"sender"|"return",provinceId:string)=>{
    const province=provinces.find(item=>String(item._id)===provinceId);
    setForm(old=>side==="sender"?({...old,senderProvinceId:provinceId,senderProvinceName:province?.name??"",senderWardId:"",senderWardName:""}):({...old,returnProvinceId:provinceId,returnProvinceName:province?.name??"",returnWardId:"",returnWardName:""}));
    if(side==="sender")setSenderWards([]);else setReturnWards([]);
    if(!editing||!provinceId)return;
    try{const list=await request<GhnLocation[]>(`/api/v1/retail/shipping/ghn/accounts/${editing.account_id}/shops/${editing.shop_record_id}/provinces/${provinceId}/wards`);if(side==="sender")setSenderWards(list);else setReturnWards(list);}
    catch(e){setError(e instanceof Error?e.message:"Không tải được danh mục phường/xã GHN.");}
  };
  const selectWard=(side:"sender"|"return",wardId:string)=>{
    const wards=side==="sender"?senderWards:returnWards,ward=wards.find(item=>String(item._id)===wardId);
    if(side==="sender")setForm(old=>({...old,senderWardId:wardId,senderWardName:ward?.name??""}));
    else setForm(old=>({...old,returnWardId:wardId,returnWardName:ward?.name??""}));
  };
  const address=(side:"sender"|"return")=>side==="sender"
    ?{name:form.senderName,phone:form.senderPhone,address:form.senderAddress,provinceId:form.senderProvinceId?Number(form.senderProvinceId):null,provinceName:form.senderProvinceName,wardId:form.senderWardId?Number(form.senderWardId):null,wardName:form.senderWardName}
    :{name:form.returnName,phone:form.returnPhone,address:form.returnAddress,provinceId:form.returnProvinceId?Number(form.returnProvinceId):null,provinceName:form.returnProvinceName,wardId:form.returnWardId?Number(form.returnWardId):null,wardName:form.returnWardName};
  const submit=async()=>{
    setBusy(true);setError("");setNotice("");
    try{
      if(editing){
        const sender=address("sender"),returnAddress=address("return");
        await request(`/api/v1/retail/shipping/ghn/accounts/${editing.account_id}/shops/${editing.shop_record_id}`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({token:form.token,shopId:Number(form.shopId),branchId:form.branchId,warehouseId:form.warehouseId,sender,returnAddress})});
      }else{
        const sender=address("sender"),returnAddress=address("return");
        const body={name:form.name,environment:form.environment,token:form.token,shopId:Number(form.shopId),shopName:form.shopName,branchId:form.branchId,warehouseId:form.warehouseId,sender,returnAddress,defaultServiceTypeId:form.defaultServiceTypeId?Number(form.defaultServiceTypeId):null,defaultPaymentTypeId:form.defaultPaymentTypeId?Number(form.defaultPaymentTypeId):null,defaultRequiredNote:form.defaultRequiredNote,isDefault:form.isDefault};
        const created=await request<{accountId:string;shopRecordId:string}>("/api/v1/retail/shipping/ghn/import",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
        const data=await request<GhnData>("/api/v1/retail/shipping/ghn/accounts");setRows(data.accounts);setCatalog({branches:data.branches,warehouses:data.warehouses});
        const saved=data.accounts.find(row=>row.shop_record_id===created.shopRecordId);
        if(saved)startEdit(saved);
      }
      if(editing){setForm(blank());setEditing(null);await load();setNotice("Đã cập nhật tài khoản, liên kết và địa chỉ.");}
      else setNotice("Đã tạo tài khoản. Chọn tỉnh/thành và phường/xã GHN cho người gửi, người nhận.");
    }catch(e){setError(e instanceof Error?e.message:"Không lưu được cấu hình GHN.");}
    finally{setBusy(false);}
  };
  const startEdit=(row:Account)=>{const sender=parseAddress(row.sender_snapshot),ret=parseAddress(row.return_snapshot);setEditing(row);setForm({...blank(),name:row.name,environment:row.environment,shopId:String(row.shop_id),shopName:row.shop_name,branchId:row.branch_id,warehouseId:row.warehouse_id,senderName:text(sender,"name"),senderPhone:text(sender,"phone"),senderAddress:text(sender,"address"),senderProvinceId:text(sender,"provinceId"),senderProvinceName:text(sender,"provinceName"),senderWardId:text(sender,"wardId"),senderWardName:text(sender,"wardName"),returnName:text(ret,"name"),returnPhone:text(ret,"phone"),returnAddress:text(ret,"address"),returnProvinceId:text(ret,"provinceId"),returnProvinceName:text(ret,"provinceName"),returnWardId:text(ret,"wardId"),returnWardName:text(ret,"wardName")});setTab("shops");setNotice("");};
  const cancelEdit=()=>{setEditing(null);setForm(blank());setError("");};
  const configureWebhook=async(accountId:string)=>{
    if(!window.confirm("Tạo khóa webhook mới? Khóa cũ sẽ hết hiệu lực. Cần cập nhật khóa này trong cấu hình webhook GHN."))return;
    setBusy(true);setError("");setWebhook(null);
    try{setWebhook(await request<{path:string;headerName:string;secret:string}>(`/api/v1/retail/shipping/ghn/accounts/${accountId}/webhook-secret`,{method:"POST"}));}
    catch(e){setError(e instanceof Error?e.message:"Không tạo được khóa webhook.");}
    finally{setBusy(false);}
  };
  const showDetails=async(row:Account)=>{
    setDetailsLoading(true);setError("");
    try{setShopDetails(await request<ShopDetails>(`/api/v1/retail/shipping/ghn/accounts/${row.account_id}/shops/${row.shop_record_id}`));}
    catch(e){setError(e instanceof Error?e.message:"Không tải được chi tiết shop GHN.");}
    finally{setDetailsLoading(false);}
  };
  const remove=async(path:string,label:string)=>{
    if(!window.confirm(`Xóa ${label}? Cấu hình sẽ được ngưng sử dụng và không bị xóa khỏi lịch sử đơn giao.`))return;
    setBusy(true);setError("");setNotice("");
    try{await request(path,{method:"DELETE"});if(editing)cancelEdit();setNotice(`Đã xóa ${label}.`);await load();}
    catch(e){setError(e instanceof Error?e.message:`Không xóa được ${label}.`);}
    finally{setBusy(false);}
  };
  return <div className="ghn-workspace">
    <header className="ghn-heading"><div><p className="ghn-eyebrow">VẬN CHUYỂN</p><h1>Giao hàng</h1><p>Quản lý tài khoản GHN và liên kết shop với chi nhánh, kho.</p></div><button type="button" onClick={()=>void load()} disabled={loading}>Làm mới</button></header>
    <nav className="ghn-tabs" role="tablist" aria-label="Quản lý giao hàng">{[["orders","Đơn giao & Tracking"],...(canManage?[["shops","Shop & kho"],["accounts","Tài khoản GHN"]]:[]),["guide","Hướng dẫn"]].map(([id,label])=><button key={id} type="button" role="tab" aria-selected={tab===id} onClick={()=>{setTab(id);setWebhook(null);}}>{label}</button>)}</nav>
    {error&&<p className="ghn-alert" role="alert">{error}</p>}{notice&&<p className="ghn-notice" role="status">{notice}</p>}
    {tab==="orders"&&<GhnOrders request={request} onNavigate={onNavigate}/>}
    {tab==="accounts"&&canManage&&<section className="ghn-panel"><h2>Webhook GHN</h2><p>Tạo khóa cho tài khoản, sau đó đăng ký URL và header tại Developer Portal GHN đúng môi trường.</p><div className="ghn-actions">{Array.from(new Map(rows.map(r=>[r.account_id,r])).values()).map(row=><button key={row.account_id} disabled={busy} onClick={()=>void configureWebhook(row.account_id)}>Tạo/đổi khóa: {row.name}</button>)}</div>{webhook&&<div className="ghn-form"><p className="ghn-wide">Khóa chỉ hiển thị lần này. Sao chép vào header tùy chỉnh trong cấu hình webhook GHN.</p><label className="ghn-wide">URL webhook<input readOnly value={apiUrl.replace(/\/$/,"")+webhook.path}/></label><label>Header<input readOnly value={webhook.headerName}/></label><label>Giá trị header<input readOnly autoComplete="off" value={webhook.secret}/></label><button onClick={()=>setWebhook(null)}>Đã lưu khóa</button></div>}</section>}
    {tab==="shops"&&<>
      {canManage?<section className="ghn-panel"><div className="ghn-panel-title"><div><h2>{editing?"Cập nhật liên kết GHN":"Thêm tài khoản và shop GHN"}</h2><p>CEO và quản trị viên hệ thống cao nhất được cấu hình. Token không hiển thị lại sau khi lưu.</p></div>{editing&&<button type="button" onClick={cancelEdit}>Hủy sửa</button>}</div>
        <div className="ghn-form">
          {!editing&&<><label>Tên tài khoản<input value={form.name} onChange={e=>set("name",e.target.value)} placeholder="GHN cửa hàng Hà Nội"/></label><label>Môi trường<select value={form.environment} onChange={e=>set("environment",e.target.value)}><option value="PRODUCTION">Production</option><option value="STAGING">Staging</option></select></label><label>Tên shop<input value={form.shopName} onChange={e=>set("shopName",e.target.value)} placeholder="Cửa hàng Hà Nội"/></label></>}
          <label>GHN Token<input type="password" autoComplete="new-password" value={form.token} onChange={e=>set("token",e.target.value)} placeholder={editing?"Để trống nếu không đổi token":"Nhập token GHN"}/></label>
          <label>Shop ID<input type="number" min="1" value={form.shopId} onChange={e=>set("shopId",e.target.value)} placeholder="Ví dụ: 123456"/></label>
          <label>Chi nhánh<select value={form.branchId} onChange={e=>set("branchId",e.target.value)}><option value="">Chọn chi nhánh</option>{catalog.branches.map(b=><option key={text(b,"id")} value={text(b,"id")}>{text(b,"name")} · {text(b,"code")}</option>)}</select></label>
          <label>Kho<select value={form.warehouseId} onChange={e=>set("warehouseId",e.target.value)}><option value="">Chọn kho</option>{warehouses.map(w=><option key={text(w,"id")} value={text(w,"id")}>{text(w,"name")} · {text(w,"code")}</option>)}</select></label>
          <fieldset className="ghn-subform"><legend>Thông tin người gửi</legend><label>Họ tên<input value={form.senderName} onChange={e=>set("senderName",e.target.value)} required/></label><label>Số điện thoại<input value={form.senderPhone} onChange={e=>set("senderPhone",e.target.value)} required/></label><label className="ghn-wide">Địa chỉ<input value={form.senderAddress} onChange={e=>set("senderAddress",e.target.value)} required/></label><label>Tỉnh/Thành{editing?<select value={form.senderProvinceId} onChange={e=>void selectProvince("sender",e.target.value)}><option value="">Chọn tỉnh/thành GHN</option>{provinces.map(item=><option key={item._id} value={item._id}>{item.name}</option>)}</select>:<input value={form.senderProvinceName} onChange={e=>set("senderProvinceName",e.target.value)} placeholder="Chọn sau khi lưu cấu hình"/>}</label><label>Phường/Xã{editing?<select value={form.senderWardId} disabled={!form.senderProvinceId||senderWards.length===0} onChange={e=>selectWard("sender",e.target.value)}><option value="">Chọn phường/xã GHN</option>{senderWards.map(item=><option key={item._id} value={item._id}>{item.name}</option>)}</select>:<input value={form.senderWardName} onChange={e=>set("senderWardName",e.target.value)} placeholder="Chọn sau khi lưu cấu hình"/>}</label></fieldset><fieldset className="ghn-subform"><legend>Địa chỉ người nhận / hoàn hàng</legend><label>Họ tên<input value={form.returnName} onChange={e=>set("returnName",e.target.value)} required/></label><label>Số điện thoại<input value={form.returnPhone} onChange={e=>set("returnPhone",e.target.value)} required/></label><label className="ghn-wide">Địa chỉ<input value={form.returnAddress} onChange={e=>set("returnAddress",e.target.value)} required/></label><label>Tỉnh/Thành{editing?<select value={form.returnProvinceId} onChange={e=>void selectProvince("return",e.target.value)}><option value="">Chọn tỉnh/thành GHN</option>{provinces.map(item=><option key={item._id} value={item._id}>{item.name}</option>)}</select>:<input value={form.returnProvinceName} onChange={e=>set("returnProvinceName",e.target.value)} placeholder="Chọn sau khi lưu cấu hình"/>}</label><label>Phường/Xã{editing?<select value={form.returnWardId} disabled={!form.returnProvinceId||returnWards.length===0} onChange={e=>selectWard("return",e.target.value)}><option value="">Chọn phường/xã GHN</option>{returnWards.map(item=><option key={item._id} value={item._id}>{item.name}</option>)}</select>:<input value={form.returnWardName} onChange={e=>set("returnWardName",e.target.value)} placeholder="Chọn sau khi lưu cấu hình"/>}</label></fieldset>{!editing&&<><p className="ghn-address-hint">Lưu tài khoản GHN trước để tải danh sách tỉnh/thành và phường/xã chính thức.</p><label>Mã dịch vụ mặc định<input type="number" value={form.defaultServiceTypeId} onChange={e=>set("defaultServiceTypeId",e.target.value)} placeholder="Tùy chọn"/></label><label>Người trả phí<select value={form.defaultPaymentTypeId} onChange={e=>set("defaultPaymentTypeId",e.target.value)}><option value="1">Người gửi trả</option><option value="2">Người nhận trả</option></select></label><label>Yêu cầu giao<select value={form.defaultRequiredNote} onChange={e=>set("defaultRequiredNote",e.target.value)}><option value="CHOXEMHANGKHONGTHU">Cho xem hàng, không thử</option><option value="CHOTHUHANG">Cho thử hàng</option><option value="KHONGCHOXEMHANG">Không cho xem hàng</option></select></label><label className="ghn-check"><input type="checkbox" checked={form.isDefault} onChange={e=>set("isDefault",e.target.checked)}/>Shop mặc định cho kho</label></>}
        </div><div className="ghn-actions"><button className="ghn-primary" type="button" disabled={busy||(!editing&&!form.token)||!form.shopId||!form.branchId||!form.warehouseId} onClick={()=>void submit()}>{busy?"Đang lưu…":editing?"Cập nhật liên kết":"Thêm shop GHN"}</button></div>
      </section>:<section className="ghn-panel"><h2>Shop GHN theo chi nhánh và kho</h2><p>Chỉ CEO và quản trị viên hệ thống cao nhất được thêm, sửa hoặc xóa cấu hình.</p></section>}
      <section className="ghn-panel"><div className="ghn-panel-title"><div><h2>Danh sách shop GHN</h2><p>Mỗi shop được liên kết với một chi nhánh và một kho.</p></div></div>{loading?<p>Đang tải cấu hình…</p>:rows.filter(row=>row.shop_record_id).length===0?<p className="ghn-empty">Chưa có shop GHN. CEO có thể thêm shop ở biểu mẫu phía trên.</p>:<div className="ghn-table-wrap"><table><thead><tr><th>Shop</th><th>Tài khoản</th><th>Chi nhánh</th><th>Kho</th><th>Môi trường</th><th>Token</th><th></th></tr></thead><tbody>{rows.filter(row=>row.shop_record_id).map(row=><tr key={row.shop_record_id}><td><strong>{row.shop_name}</strong><small>Shop ID: {row.shop_id||"—"}{row.is_default?" · Mặc định":""}</small></td><td>{row.name}</td><td>{row.branch_name||"—"}</td><td>{row.warehouse_name||"—"}</td><td><span className="ghn-badge">{row.environment}</span></td><td>{row.token_configured?"Đã cấu hình":"Chưa có"}</td><td><div className="ghn-actions"><button type="button" onClick={()=>void showDetails(row)} disabled={detailsLoading}>Chi tiết</button>{canManage&&<button type="button" onClick={()=>startEdit(row)}>Sửa</button>}</div></td></tr>)}</tbody></table></div>}
        {shopDetails&&<div className="ghn-detail"><div className="ghn-panel-title"><div><h3>Chi tiết shop: {text(shopDetails,"shop_name")}</h3><p>Tài khoản {text(shopDetails,"name")} · Shop ID {text(shopDetails,"shop_id")}</p></div><button type="button" onClick={()=>setShopDetails(null)}>Đóng</button></div>
          <dl className="ghn-detail-grid"><div><dt>Môi trường</dt><dd>{text(shopDetails,"environment")}</dd></div><div><dt>Token</dt><dd>{shopDetails.token_configured?"Đã cấu hình":"Chưa có"}</dd></div><div><dt>Chi nhánh</dt><dd>{text(shopDetails,"branch_name")||"—"}</dd></div><div><dt>Kho</dt><dd>{text(shopDetails,"warehouse_name")||"—"}</dd></div><div><dt>Shop mặc định</dt><dd>{shopDetails.is_default?"Có":"Không"}</dd></div><div><dt>Mã dịch vụ mặc định</dt><dd>{text(shopDetails,"default_service_type_id")||"—"}</dd></div><div><dt>Người trả phí</dt><dd>{text(shopDetails,"default_payment_type_id")==="1"?"Người gửi":"Người nhận"}</dd></div><div><dt>Yêu cầu giao</dt><dd>{text(shopDetails,"default_required_note")||"—"}</dd></div></dl>
          <div className="ghn-detail-addresses">{([["Người gửi","sender_snapshot"],["Địa chỉ hoàn hàng","return_snapshot"]] as const).map(([label,key])=>{const address=parseAddress(text(shopDetails,key));return <article key={key}><h4>{label}</h4><p><strong>{text(address,"name")||"—"}</strong> · {text(address,"phone")||"—"}</p><p>{text(address,"address")||"—"}</p><p>{[text(address,"wardName"),text(address,"provinceName")].filter(Boolean).join(", ")||"Chưa cấu hình tỉnh/thành, phường/xã"}</p></article>;})}</div>
        </div>}
      </section>
    </>}
    {tab==="accounts"&&<section className="ghn-panel"><h2>Tài khoản GHN</h2><p>Danh sách tài khoản và môi trường đang sử dụng.</p><div className="ghn-account-cards">{Array.from(new Map(rows.map(r=>[r.account_id,r])).values()).map(row=><article key={row.account_id}><span className="ghn-badge">{row.environment}</span><h3>{row.name}</h3><p>{row.account_active?"Đang hoạt động":"Đã ngưng"} · {row.token_configured?"Token đã cấu hình":"Thiếu token"}</p><small>Mã tài khoản: {row.account_id}</small>{canManage&&<button className="ghn-delete-account" type="button" disabled={busy} onClick={()=>void remove(`/api/v1/retail/shipping/ghn/accounts/${row.account_id}`,`tài khoản ${row.name}`)}>Xóa tài khoản</button>}</article>)}{!rows.length&&!loading&&<p className="ghn-empty">Chưa có tài khoản GHN.</p>}</div></section>}
    {tab==="guide"&&<section className="ghn-panel"><h2>Quy trình cấu hình</h2><ol className="ghn-guide"><li>Chọn <b>Thêm tài khoản và shop GHN</b>.</li><li>Nhập token, Shop ID và tên shop do GHN cấp.</li><li>Chọn chi nhánh và kho gửi hàng tương ứng.</li><li>Điền thông tin người gửi và địa chỉ hoàn hàng vào các trường tương ứng.</li><li>Lưu cấu hình. Token không hiển thị lại sau khi lưu.</li><li>Khi ngưng sử dụng, xóa tài khoản; cấu hình sẽ được vô hiệu hóa để giữ lịch sử đơn giao.</li></ol><p>CEO và quản trị viên hệ thống cao nhất được thêm, sửa và xóa cấu hình.</p></section>}
  </div>;
}
