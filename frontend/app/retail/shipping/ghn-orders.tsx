"use client";
import { useCallback, useEffect, useState } from "react";
import type { ModuleRequest } from "../../module-contract";

type Row = Record<string, unknown>;
type Location = { _id:number; name:string; status?:number };
type Detail = Row & { issues:Row[]; items:Row[]; shops:Row[]; deliveries:Row[]; events:Row[]; canCreate:boolean; customer_snapshot:Row; shipping_address_snapshot:Row };
type Quote = { quoteId:string; totalFee:number; codAmount:number; paymentTypeId:number; expectedDeliveryTime:string };
type Package = { issueLineId:string; quantity:string; weight:string; length:string; width:string; height:string };
const text=(r:Row,k:string)=>String(r[k]??"");
const amount=(v:unknown)=>Number(v??0).toLocaleString("vi-VN")+" đ";
const date=(v:unknown)=>v?new Date(String(v)).toLocaleString("vi-VN"):"—";
const statuses:Record<string,string>={PENDING:"Chờ chuẩn bị",PREPARING:"Chuẩn bị giao",SHIPPING:"Đang giao",PARTIAL:"Giao một phần",DELIVERED:"Giao thành công",FAILED:"Cần xử lý giao thất bại",QUEUED:"Chờ tạo vận đơn",CREATING:"Đang tạo / chờ kết quả",CREATED:"Đã tạo",UNKNOWN:"Chưa rõ kết quả GHN",ERROR:"GHN từ chối",ready_to_pick:"Chờ lấy hàng",picking:"Đang lấy hàng",picked:"Đã lấy hàng",delivering:"Đang giao",delivered:"Giao thành công",delivery_fail:"Giao thất bại",returned:"Đã hoàn hàng",cancel:"Đã hủy"};
const initial=()=>({issueId:"",shopRecordId:"",name:"",phone:"",address:"",provinceId:"",wardId:"",weight:"",length:"",width:"",height:"",serviceTypeId:"2",paymentTypeId:"1",codAmount:"0",insuranceValue:"0",requiredNote:"CHOXEMHANGKHONGTHU",note:""});
const base="/api/v1/retail/shipping/ghn/orders";

export default function GhnOrders({request,onNavigate}:{request:ModuleRequest;onNavigate:(view:string)=>void}){
  const [orders,setOrders]=useState<Row[]>([]),[detail,setDetail]=useState<Detail|null>(null);
  const [form,setForm]=useState(initial),[packages,setPackages]=useState<Package[]>([]);
  const [provinces,setProvinces]=useState<Location[]>([]),[wards,setWards]=useState<Location[]>([]);
  const [quote,setQuote]=useState<Quote|null>(null),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true);
  const [error,setError]=useState(""),[notice,setNotice]=useState("");
  const load=useCallback(async()=>{
    setLoading(true);
    try{setOrders(await request<Row[]>(base));}
    catch(e){setError(e instanceof Error?e.message:"Không tải được yêu cầu giao.");}
    finally{setLoading(false);}
  },[request]);
  useEffect(()=>{void load();},[load]);
  const open=async(id:string)=>{
    setBusy(true);setError("");setNotice("");setQuote(null);setDetail(null);
    try{
      const d=await request<Detail>(base+"/"+id);setDetail(d);
      setForm({...initial(),name:text(d.customer_snapshot,"name"),phone:text(d.customer_snapshot,"phone"),address:text(d.shipping_address_snapshot,"fullAddress")});
      setPackages([]);
    }catch(e){setError(e instanceof Error?e.message:"Không tải được đơn bán.");}
    finally{setBusy(false);}
  };
  const orderId=detail?text(detail,"id"):"";
  useEffect(()=>{
    setProvinces([]);setWards([]);
    if(!orderId||!form.shopRecordId)return;
    let active=true;
    request<Location[]>(base+"/"+orderId+"/shops/"+form.shopRecordId+"/provinces")
      .then(rows=>{if(active)setProvinces(rows.filter(r=>r.status===undefined||r.status===1));})
      .catch(e=>{if(active)setError(e instanceof Error?e.message:"Không tải được tỉnh/thành.");});
    return()=>{active=false;};
  },[orderId,form.shopRecordId,request]);
  useEffect(()=>{
    setWards([]);
    if(!orderId||!form.shopRecordId||!form.provinceId)return;
    let active=true;
    request<Location[]>(base+"/"+orderId+"/shops/"+form.shopRecordId+"/provinces/"+form.provinceId+"/wards")
      .then(rows=>{if(active)setWards(rows.filter(r=>r.status===undefined||r.status===1));})
      .catch(e=>{if(active)setError(e instanceof Error?e.message:"Không tải được phường/xã.");});
    return()=>{active=false;};
  },[orderId,form.shopRecordId,form.provinceId,request]);
  const change=(key:keyof ReturnType<typeof initial>,value:string)=>{
    setQuote(null);setNotice("");setForm(old=>({...old,[key]:value,...(key==="provinceId"?{wardId:""}:{}),...(key==="shopRecordId"?{provinceId:"",wardId:""}:{})}));
  };
  const chooseIssue=(id:string)=>{
    if(!detail)return;
    const issue=detail.issues.find(i=>text(i,"id")===id);
    const shop=detail.shops.find(s=>text(s,"warehouse_id")===text(issue??{},"warehouse_id"));
    setQuote(null);setNotice("");
    setForm(old=>({...old,issueId:id,shopRecordId:shop?text(shop,"id"):"",provinceId:"",wardId:"",codAmount:"0",
      paymentTypeId:shop?text(shop,"default_payment_type_id")||"1":"1",requiredNote:shop?text(shop,"default_required_note")||initial().requiredNote:initial().requiredNote}));
    setPackages(detail.items.filter(i=>text(i,"issue_id")===id).map(i=>({issueLineId:text(i,"id"),quantity:String(Math.max(1,Math.ceil(Number(i.qty)))),weight:"",length:"",width:"",height:""})));
  };
  const calculate=async()=>{
    setBusy(true);setError("");setQuote(null);setNotice("");
    try{
      const body={issueId:form.issueId,shopRecordId:form.shopRecordId,recipient:{name:form.name,phone:form.phone,address:form.address,provinceId:Number(form.provinceId),wardId:Number(form.wardId)},
        weight:Number(form.weight),length:Number(form.length),width:Number(form.width),height:Number(form.height),serviceTypeId:Number(form.serviceTypeId),
        paymentTypeId:Number(form.paymentTypeId),codAmount:Number(form.codAmount),insuranceValue:Number(form.insuranceValue),requiredNote:form.requiredNote,note:form.note,
        items:packages.map(p=>({...p,quantity:Number(p.quantity),weight:Number(p.weight),length:Number(p.length),width:Number(p.width),height:Number(p.height)}))};
      setQuote(await request<Quote>(base+"/"+orderId+"/quote",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}));
    }catch(e){setError(e instanceof Error?e.message:"Không lấy được phí GHN.");}
    finally{setBusy(false);}
  };
  const send=async(deliveryId?:string)=>{
    if(!detail||!deliveryId&&!quote)return;
    setBusy(true);setError("");setNotice("");
    try{
      const result=await request<Detail>(base+"/"+orderId+(deliveryId?"/deliveries/"+deliveryId+"/retry":"/confirm"),{
        method:"POST",headers:{"Content-Type":"application/json"},body:deliveryId?undefined:JSON.stringify({quoteId:quote!.quoteId,acceptedFee:quote!.totalFee,codAmount:quote!.codAmount,paymentTypeId:quote!.paymentTypeId})});
      setDetail(result);setQuote(null);setForm(old=>({...old,issueId:"",shopRecordId:""}));setPackages([]);
      setNotice("Đã cập nhật kết quả. Xem mã vận đơn và tình trạng xử lý bên dưới.");await load();
    }catch(e){setError(e instanceof Error?e.message:"Chưa nhận được kết quả. Mở lại đơn để kiểm tra trước khi thao tác tiếp.");}
    finally{setBusy(false);}
  };
  const issue=detail?.issues.find(i=>text(i,"id")===form.issueId);
  return <section className="ghn-panel">
    <div className="ghn-panel-title"><div><h2>Yêu cầu giao từ đơn sale</h2><p>Đơn đã xác nhận tự xuất hiện tại đây. Chọn phiếu xuất đã ghi sổ, lấy phí rồi xác nhận tạo vận đơn.</p></div><button disabled={busy||loading} onClick={()=>{void load();if(orderId)void open(orderId);}}>Làm mới</button></div>
    {error&&<p className="ghn-alert" role="alert">{error}</p>}{notice&&<p className="ghn-notice" role="status">{notice}</p>}
    {loading?<p role="status">Đang tải yêu cầu giao…</p>:<div className="ghn-table-wrap"><table><thead><tr><th>Đơn bán</th><th>Khách hàng</th><th>Kho</th><th>Giao hàng</th><th>Mã vận đơn</th><th/></tr></thead><tbody>{orders.map(o=><tr key={text(o,"id")}><td>{text(o,"order_number")}</td><td>{text(o,"customer")}</td><td>{text(o,"warehouse")}</td><td>{statuses[text(o,"shipping_status")]||text(o,"shipping_status")}</td><td>{text(o,"tracking")||"—"}</td><td><button disabled={busy} onClick={()=>void open(text(o,"id"))}>Xử lý / Tracking</button></td></tr>)}</tbody></table>{!orders.length&&<p className="ghn-empty">Chưa có đơn sale đã xác nhận trong phạm vi của bạn.</p>}</div>}
    {detail&&<div className="ghn-detail">
      <div className="ghn-panel-title"><div><h3>{text(detail,"order_number")} · {statuses[text(detail,"shipping_status")]||text(detail,"shipping_status")}</h3><p>Mỗi phiếu xuất tạo một vận đơn. Đơn xuất nhiều đợt sẽ có nhiều vận đơn.</p></div><button disabled={busy} onClick={()=>setDetail(null)}>Đóng</button></div>
      {detail.canCreate&&text(detail,"status")==="CONFIRMED"&&<>
        {!detail.issues.length?<p>Chưa có phiếu xuất đã ghi sổ còn chờ giao. <button onClick={()=>onNavigate("retail-stock")}>Mở kho hàng</button></p>:<fieldset className="ghn-shipment-fields" disabled={busy}><legend>Chuẩn bị vận đơn GHN</legend><div className="ghn-form">
          <label>Phiếu xuất kho<select value={form.issueId} onChange={e=>chooseIssue(e.target.value)}><option value="">Chọn phiếu xuất đã ghi sổ</option>{detail.issues.map(i=><option key={text(i,"id")} value={text(i,"id")}>{text(i,"number")} · {text(i,"warehouse")}</option>)}</select></label>
          <label>Shop lấy hàng<select value={form.shopRecordId} onChange={e=>change("shopRecordId",e.target.value)} disabled={!form.issueId}><option value="">Chọn shop GHN của kho</option>{detail.shops.filter(s=>text(s,"warehouse_id")===text(issue??{},"warehouse_id")).map(s=><option key={text(s,"id")} value={text(s,"id")}>{text(s,"shop_name")} · {text(s,"environment")}</option>)}</select></label>
          <label>Người nhận<input value={form.name} onChange={e=>change("name",e.target.value)} maxLength={1024}/></label>
          <label>Số điện thoại<input type="tel" value={form.phone} onChange={e=>change("phone",e.target.value)}/></label>
          <label className="ghn-wide">Địa chỉ người nhận<input value={form.address} onChange={e=>change("address",e.target.value)} maxLength={1024}/></label>
          <label>Tỉnh / thành<select value={form.provinceId} disabled={!provinces.length} onChange={e=>change("provinceId",e.target.value)}><option value="">Chọn tỉnh/thành GHN</option>{provinces.map(p=><option key={p._id} value={p._id}>{p.name}</option>)}</select></label>
          <label>Phường / xã<select value={form.wardId} disabled={!wards.length} onChange={e=>change("wardId",e.target.value)}><option value="">Chọn phường/xã GHN</option>{wards.map(w=><option key={w._id} value={w._id}>{w.name}</option>)}</select></label>
          {([["weight","Tổng khối lượng (gram)"],["length","Dài (cm)"],["width","Rộng (cm)"],["height","Cao (cm)"]] as const).map(([key,label])=><label key={key}>{label}<input type="number" min="1" value={form[key]} onChange={e=>change(key,e.target.value)}/></label>)}
          <label>Dịch vụ GHN<select value={form.serviceTypeId} onChange={e=>change("serviceTypeId",e.target.value)}><option value="2">Hàng nhẹ (dưới 20 kg)</option><option value="5">Hàng nặng / nhiều kiện</option></select></label>
          <label>Người trả phí vận chuyển<select value={form.paymentTypeId} onChange={e=>change("paymentTypeId",e.target.value)}><option value="1">Người gửi trả</option><option value="2">Người nhận trả</option></select></label>
          <label>COD cần thu (đ)<input type="number" min="0" max="50000000" value={form.codAmount} onChange={e=>change("codAmount",e.target.value)}/><small>Công nợ phiếu xuất: {amount(issue?.outstanding)}. Nhập 0 nếu không thu hộ.</small></label>
          <label>Khai giá bảo hiểm (đ)<input type="number" min="0" max="5000000" value={form.insuranceValue} onChange={e=>change("insuranceValue",e.target.value)}/></label>
          <label>Yêu cầu giao<select value={form.requiredNote} onChange={e=>change("requiredNote",e.target.value)}><option value="CHOXEMHANGKHONGTHU">Cho xem hàng, không thử</option><option value="CHOTHUHANG">Cho thử hàng</option><option value="KHONGCHOXEMHANG">Không cho xem hàng</option></select></label>
          <label>Ghi chú tài xế<input value={form.note} onChange={e=>change("note",e.target.value)} maxLength={5000}/></label>
        </div>
        {!!packages.length&&<div className="ghn-table-wrap"><h4>Hàng hóa / đóng gói</h4><p>Số kiện là số đơn vị đóng gói gửi GHN. Khối lượng/kích thước từng kiện bắt buộc với dịch vụ hàng nặng.</p><table><thead><tr><th>Hàng đã xuất</th><th>Số kiện</th>{form.serviceTypeId==="5"&&<><th>Gram / kiện</th><th>Dài (cm)</th><th>Rộng (cm)</th><th>Cao (cm)</th></>}</tr></thead><tbody>{packages.map((p,index)=>{const item=detail.items.find(i=>text(i,"id")===p.issueLineId)??{};return <tr key={p.issueLineId}><td>{text(item,"name")}<small>{text(item,"qty")} {text(item,"unit")}</small></td>{(["quantity",...(form.serviceTypeId==="5"?["weight","length","width","height"]:[])] as (keyof Omit<Package,"issueLineId">)[]).map(key=><td key={key}><input aria-label={text(item,"name")+" "+key} className="ghn-package-input" type="number" min="1" value={p[key]} onChange={e=>{setQuote(null);setPackages(old=>old.map((v,i)=>i===index?{...v,[key]:e.target.value}:v));}}/></td>)}</tr>;})}</tbody></table></div>}
        <div className="ghn-actions"><button className="ghn-primary" disabled={!form.issueId||!form.shopRecordId||!form.wardId||!form.weight} onClick={()=>void calculate()}>Tính phí GHN</button></div>
        </fieldset>}
        {quote&&<div className="ghn-quote-summary" role="status"><h4>Xác nhận giao hàng</h4><p>Phí dự kiến: <strong>{amount(quote.totalFee)}</strong> · {quote.paymentTypeId===1?"Người gửi trả phí":"Người nhận trả phí"}</p><p>COD: <strong>{amount(quote.codAmount)}</strong> · Dự kiến giao: {date(quote.expectedDeliveryTime)}</p><p>Báo phí có hiệu lực 15 phút. Phí thực tế có thể thay đổi sau khi GHN cân đo.</p><button className="ghn-primary" disabled={busy} onClick={()=>void send()}>{busy?"Đang xử lý…":"Xác nhận phí, COD và tạo vận đơn"}</button></div>}
      </>}
      <h4>Vận đơn và kết quả giao</h4>{detail.deliveries.length?<div className="ghn-table-wrap"><table><thead><tr><th>Mã vận đơn</th><th>Tạo đơn GHN</th><th>Trạng thái giao</th><th>COD / phí</th><th/></tr></thead><tbody>{detail.deliveries.map(d=><tr key={text(d,"id")}><td><strong>{text(d,"tracking")||"Chưa có mã"}</strong><small>Dự kiến: {date(d.expected_delivery_at)}</small></td><td>{statuses[text(d,"integration_status")]||text(d,"integration_status")}<small>{text(d,"last_error_message")}</small></td><td>{statuses[text(d,"carrier_status")]||text(d,"carrier_status")||statuses[text(d,"status")]}<small>{text(d,"note")}</small></td><td>{amount(d.cod)} / {amount(d.carrier_fee_current??d.fee)}</td><td>{detail.canCreate&&["UNKNOWN","ERROR","CREATING","QUEUED"].includes(text(d,"integration_status"))&&<button disabled={busy} onClick={()=>void send(text(d,"id"))}>{text(d,"integration_status")==="ERROR"||text(d,"integration_status")==="QUEUED"?"Thử gửi lại":"Tra cứu kết quả GHN"}</button>}</td></tr>)}</tbody></table></div>:<p>Chưa tạo vận đơn.</p>}
      {!!detail.events.length&&<><h4>Lịch sử GHN cập nhật</h4><ol className="ghn-tracking-events">{detail.events.map(e=><li key={text(e,"id")}><time>{date(e.event_time)}</time><strong>{text(e,"carrier_order_code")} · {statuses[text(e,"carrier_status")]||text(e,"carrier_status")||text(e,"event_type")}</strong><span>{text(e,"reason")}</span></li>)}</ol></>}
    </div>}
  </section>;
}
