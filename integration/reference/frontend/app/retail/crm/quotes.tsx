"use client";

import {useCallback, useEffect, useState} from "react";
import {Eye, HandCoins, Plus, ShoppingCart, X} from "lucide-react";
import {CrmTable} from "./crm-table";
import {CrmButton as Button} from "./crm-button";
import SalesWorkspace from "../sales/sales-workspace";
import QuoteShippingFields, { initialShipping, fulfillQuote, type ShippingInput } from "../sales/quote-fulfillment";
import {num, quantity, text, timestamp} from "@/components/retail/shared/format";
import {toast} from "@/hooks/use-toast";

type Row=Record<string,unknown>;
type Quote={id:string;number?:string;pipeline_type?:string;status?:string;version?:number;total?:number;fee?:number;customer?:string;customer_group?:string;products?:string;creator?:string;creator_id?:string;partner_id?:string;branch_id?:string;approval_result?:string;created_at?:string;note?:string;reason?:string;lines?:Row[];metadata?:Row;orderEvents?:Row[];collectionHistory?:Row[];order_id?:string;order_number?:string;order_status?:string;order_created_at?:string;order_total?:number;paid_amount?:number;debt_amount?:number;prepaid_amount?:number;export_available?:boolean};

const statusLabel=(value?:string)=>({DRAFT:"Nháp",PENDING:"Chờ duyệt",APPROVED:"Đã duyệt",REJECTED:"Từ chối",CANCELLED:"Đã hủy",CLOSED:"Đã đóng báo giá"}[value||""]||value||"Chờ duyệt");
const orderStatusLabel=(value?:string)=>({APPROVED:"Đã xác nhận",PARTIAL:"Đã xuất một phần",COMPLETE:"Đã xuất đủ",CLOSED:"Đã đóng",CANCELLED:"Đã hủy"}[value||""]||value||"Chưa có đơn bán");
const orderEventLabel=(value:string)=>({CREATED_FROM_QUOTE:"Tạo đơn từ báo giá",SUBMIT:"Xác nhận đơn hàng",CANCEL:"Hủy đơn hàng",CLOSE:"Đóng phần chưa thực hiện"}[value]||value);
const paymentMethodLabel=(value:string)=>({CASH:"Tiền mặt",BANK:"Chuyển khoản",CARD:"Thẻ",OTHER:"Khác",OFFSET:"Bù trừ"}[value]||value);
const money=(value?:number)=>new Intl.NumberFormat("vi-VN").format(Number(value||0))+" đ";

type RequestApi=<T>(path:string,init?:RequestInit)=>Promise<T>;
type CatalogCapabilities={capabilities?:Record<string,string[]>;accountId?:string;canSelfApprove?:boolean;salesRole?:boolean;platformAdmin?:boolean};

export default function Quotes({request,apiUrl="",onNavigate,isCeo=false,contractsMode=false}:{request:RequestApi;apiUrl?:string;onNavigate?:(view:string)=>void;isCeo?:boolean;contractsMode?:boolean}){
  const [rows,setRows]=useState<Quote[]>([]);
  const [q,setQ]=useState("");
  const [status,setStatus]=useState("");
  const [selected,setSelected]=useState<Quote|null>(null);
  const [loading,setLoading]=useState(true);
  const [composerCustomerId,setComposerCustomerId]=useState("");
  const [composerOpportunityId,setComposerOpportunityId]=useState("");
  const [composerBranchId,setComposerBranchId]=useState("");
  const [composerOpen,setComposerOpen]=useState(false);
  const [capabilities,setCapabilities]=useState<Record<string,string[]>>({});
  const [account,setAccount]=useState<{accountId?:string;canSelfApprove?:boolean;salesRole?:boolean;platformAdmin?:boolean}>({});
  const [busy,setBusy]=useState(false);
  const [pendingAction,setPendingAction]=useState<""|"approve"|"reject"|"xlsx"|"pdf"|"pdf-preview"|"send"|"response"|"order">("");
  const [reviewNote,setReviewNote]=useState("");
  const [sendChannel,setSendChannel]=useState("EMAIL");
  const [sendRecipient,setSendRecipient]=useState("");
  const [responseNote,setResponseNote]=useState("");
  const [detailError,setDetailError]=useState("");
  const [conversionQuote,setConversionQuote]=useState<Quote|null>(null);
  const [conversionInput,setConversionInput]=useState({channel:"PHONE",recipient:"",note:""});
  const [conversionError,setConversionError]=useState("");
  const [conversionShipping,setConversionShipping]=useState<ShippingInput|null>(null);

  useEffect(()=>{
    const launch=sessionStorage.getItem("retail.quote-launch");
    if(!launch)return;
    sessionStorage.removeItem("retail.quote-launch");
    try{
      const payload=JSON.parse(launch) as {customerId?:string;opportunityId?:string;branchId?:string};
      if(payload.customerId)setComposerCustomerId(payload.customerId);
      setComposerOpportunityId(payload.opportunityId??"");setComposerBranchId(payload.branchId??"");
    }catch{
      sessionStorage.removeItem("retail.quote-launch");
    }
  },[]);

  const load=useCallback(async()=>{
    setLoading(true);
    try{
      const endpoint=contractsMode?"contracts":"quotes";
      const statusParam=contractsMode?"orderStatus":"status";
      const body=await request<Quote[]|{items?:Quote[];content?:Quote[]}>(`/api/v1/retail/crm/${endpoint}?q=${encodeURIComponent(q)}&${statusParam}=${encodeURIComponent(status)}`);
      setRows(Array.isArray(body)?body:body.items||body.content||[]);
    }finally{setLoading(false);}
  },[q,status,request,contractsMode]);

  const closeQuoteComposer=useCallback(()=>{
    setComposerOpen(false);
    setComposerCustomerId("");
    setComposerOpportunityId("");
    setComposerBranchId("");
    void load().catch(error=>toast.destructive({title:"Không thể tải danh sách báo giá",description:error instanceof Error?error.message:"Vui lòng tải lại trang."}));
  },[load]);

  useEffect(()=>{void load();},[load]);

  useEffect(()=>{void request<CatalogCapabilities>("/api/v1/retail/catalog").then(body=>{setCapabilities(body.capabilities||{});setAccount({accountId:body.accountId,canSelfApprove:body.canSelfApprove,salesRole:body.salesRole,platformAdmin:body.platformAdmin});}).catch(()=>{setCapabilities({});setAccount({});});},[request]);

  const closeDetail=useCallback(()=>{setSelected(null);setDetailError("");setReviewNote("");setPendingAction("");},[]);

  const openDetail=useCallback(async(row:Quote)=>{
    setBusy(true);setDetailError("");setReviewNote("");setPendingAction("");setSendRecipient("");setResponseNote("");
    try{
      const detail=await request<Quote>(contractsMode?`/api/v1/retail/crm/contracts/${row.id}`:`/api/v1/retail/documents/${row.id}`);
      setSelected({...row,...detail});
    }catch(cause){
      toast.destructive({title:"Không mở được chi tiết báo giá",description:cause instanceof Error?cause.message:"Vui lòng thử lại."});
    }finally{setBusy(false);}
  },[request]);

  const transition=async(action:"approve"|"reject")=>{
    if(!selected)return;
    const reason=reviewNote.trim();
    if(!reason){setDetailError(action==="approve"?"Cần ghi lý do duyệt để lưu vết quyết định.":"Cần ghi lý do từ chối để Sales chỉnh sửa báo giá.");return;}
    setBusy(true);setPendingAction(action);setDetailError("");
    try{
      const updated=await request<Quote>(`/api/v1/retail/documents/${selected.id}/${action}`,{method:"POST",headers:{"Idempotency-Key":crypto.randomUUID()},body:JSON.stringify({version:selected.version,reason})});
      const number=updated.number||selected.number||"";
      setSelected({...selected,...updated});setReviewNote("");
      toast.success(action==="approve"
        ?{title:`Đã duyệt báo giá ${number}`,description:"Sales đã có thể xuất file Excel gửi khách."}
        :{title:`Đã từ chối báo giá ${number}`,description:"Báo giá trả về Sales kèm lý do của bạn."});
      await load();
    }catch(cause){
      const message=cause instanceof Error?cause.message:"Không thực hiện được thao tác duyệt.";
      setDetailError(message);
      toast.destructive({title:action==="approve"?"Không duyệt được báo giá":"Không từ chối được báo giá",description:message});
    }finally{setBusy(false);setPendingAction("");}
  };
  const recordSent=async()=>{
    if(!selected)return;
    if(!sendRecipient.trim()){setDetailError("Nhập email hoặc thông tin người nhận trước khi ghi nhận gửi khách.");return;}
    setBusy(true);setPendingAction("send");setDetailError("");
    try{
      const updated=await request<Quote>(`/api/v1/retail/documents/${selected.id}/record-sent`,{method:"POST",headers:{"Idempotency-Key":crypto.randomUUID()},body:JSON.stringify({version:selected.version,channel:sendChannel,recipient:sendRecipient.trim()})});
      setSelected({...selected,...updated});
      toast.success({title:"Đã ghi nhận gửi báo giá",description:`${selected.number||"Báo giá"} đã được gửi cho khách hàng.`});
      await load();
    }catch(cause){setDetailError(cause instanceof Error?cause.message:"Không thể ghi nhận gửi báo giá.");}
    finally{setBusy(false);setPendingAction("");}
  };
  const createOrder=async(row:Quote|null=selected)=>{
    if(!row||busy||isCeo)return;
    setBusy(true);setPendingAction("order");setDetailError("");
    try{
      const quote=await request<Quote>(`/api/v1/retail/documents/${row.id}`);
      if(quote.status!=="APPROVED")throw new Error("Báo giá cần được duyệt trước khi tạo đơn.");
      if(text(quote.metadata,"pipelineType")==="EPC")throw new Error("Báo giá EPC tiếp tục trong Pipeline EPC.");
      const metadata=(quote.metadata??{}) as Row,contact=(metadata.partnerSnapshot??{}) as Row;
      setConversionInput({channel:"PHONE",recipient:text(metadata,"sentTo")||text(contact,"phone")||text(contact,"email")||text(contact,"name"),note:""});
      setConversionShipping(initialShipping(quote));setConversionError("");setConversionQuote(quote);
    }catch(cause){setDetailError(cause instanceof Error?cause.message:"Không thể mở xác nhận đơn hàng.");}
    finally{setBusy(false);setPendingAction("");}
  };
  const confirmCustomerAndConvert=async()=>{
    if(!conversionQuote||!conversionShipping||busy)return;
    setBusy(true);setPendingAction("order");setConversionError("");
    try{
      const result=await fulfillQuote(request,conversionQuote.id,{...conversionInput,version:conversionQuote.version,shipping:conversionShipping});
      setConversionQuote(null);toast.success({title:result.orderNumber,description:`Đã tạo đơn, trừ tồn và tạo vận đơn GHN ${result.tracking}.`});
      onNavigate?.("retail-orders");
    }catch(cause){setConversionError(cause instanceof Error?cause.message:"Chưa hoàn tất; thử lại để kiểm tra kết quả.");}
    finally{setBusy(false);setPendingAction("");}
  };
  const recordResponse=async(response:"ACCEPTED"|"DECLINE"="DECLINE")=>{
    if(!selected)return;
    setBusy(true);setPendingAction("response");setDetailError("");
    try{
      const updated=await request<Quote>(`/api/v1/retail/documents/${selected.id}/${response==="ACCEPTED"?"record-response":"customer-decline"}`,{method:"POST",headers:{"Idempotency-Key":crypto.randomUUID()},body:JSON.stringify({version:selected.version,response,note:responseNote.trim()})});
      setSelected({...selected,...updated});setResponseNote("");
      toast.success({title:"Đã ghi nhận phản hồi khách hàng",description:response==="ACCEPTED"?"Khách đã đồng ý báo giá EPC. Tiếp tục hoàn thiện hợp đồng trong Pipeline EPC.":"Báo giá đã đóng; Sales có thể lập bản mới."});
      await load();
    }catch(cause){setDetailError(cause instanceof Error?cause.message:"Không thể ghi nhận phản hồi khách hàng.");}
    finally{setBusy(false);setPendingAction("");}
  };
  const declineCustomerQuote=async()=>{
    if(!conversionQuote||busy)return;
    setBusy(true);setPendingAction("response");setConversionError("");
    try{
      let quote=await request<Quote>(`/api/v1/retail/documents/${conversionQuote.id}`);
      if(quote.status!=="APPROVED"||text(quote.metadata,"responseAt")||["ACCEPTED","DECLINE"].includes(text(quote.metadata,"customerResponse")))throw new Error("Báo giá đã có phản hồi hoặc không còn ở trạng thái được duyệt. Vui lòng tải lại.");
      if(!text(quote.metadata,"sentAt")){
        if(!conversionInput.recipient.trim())throw new Error("Nhập thông tin khách đã trao đổi.");
        quote=await request<Quote>(`/api/v1/retail/documents/${quote.id}/record-sent`,{method:"POST",headers:{"Idempotency-Key":`quote-decline-${quote.id}-${quote.version}-sent`},body:JSON.stringify({version:quote.version,channel:conversionInput.channel,recipient:conversionInput.recipient.trim()})});
      }
      const updated=await request<Quote>(`/api/v1/retail/documents/${quote.id}/customer-decline`,{method:"POST",headers:{"Idempotency-Key":`quote-decline-${quote.id}-${quote.version}-response`},body:JSON.stringify({version:quote.version,note:conversionInput.note.trim()})});
      setSelected(updated);setConversionQuote(null);
      toast.success({title:"Đã ghi nhận khách không đồng ý",description:"Báo giá được giữ trong hồ sơ và đóng lại. Không tạo đơn hàng."});
      await load();
    }catch(cause){setConversionError(cause instanceof Error?cause.message:"Không thể ghi nhận khách không đồng ý.");}
    finally{setBusy(false);setPendingAction("");}
  };

  const exportQuote=async(format:"xlsx"|"pdf",preview=false)=>{
    if(!selected)return;
    setBusy(true);setPendingAction(preview?"pdf-preview":format);setDetailError("");
    const previewTab=preview?window.open("","_blank"):null;
    try{
      const token=window.localStorage.getItem("core-access-token")||window.sessionStorage.getItem("core-access-token")||"";
      const disposition=preview?"&disposition=inline":"";
      const response=await fetch(`${apiUrl}/api/v1/retail/documents/${selected.id}/quote-export?format=${format}${disposition}`,{headers:{Authorization:"Bearer "+token}});
      if(!response.ok){const problem=await response.json().catch(()=>({}));throw new Error(problem.detail||"Không thể xuất báo giá.");}
      const blob=await response.blob();
      const url=URL.createObjectURL(blob);
      if(preview){
        if(!previewTab)throw new Error("Trình duyệt đã chặn tab xem trước. Hãy dùng nút Tải PDF.");
        previewTab.location.href=url;
        window.setTimeout(()=>URL.revokeObjectURL(url),60_000);
        toast.success({title:"Đã mở bản báo giá",description:`${selected.number||""} · xem trước PDF`});
      }else{
        const anchor=document.createElement("a");anchor.href=url;anchor.download=`bao-gia-${selected.number||selected.id}.${format}`;anchor.click();URL.revokeObjectURL(url);
        toast.success({title:"Đã tải bản báo giá",description:`${selected.number||""} · định dạng ${format.toUpperCase()}`});
      }
    }catch(cause){
      previewTab?.close();
      const message=cause instanceof Error?cause.message:"Không thể xuất báo giá.";
      setDetailError(message);
      toast.destructive({title:"Không xuất được báo giá",description:message});
    }finally{setBusy(false);setPendingAction("");}
  };

  const meta=(selected?.metadata??{}) as Row;
  const partner=(meta.partnerSnapshot??{}) as Row;
  const review=(meta.managerReview??{}) as Row;
  const detailLines=(selected?.lines??[]) as Row[];
  const orderEvents=selected?.orderEvents??[];
  const collectionHistory=selected?.collectionHistory??[];
  const canApprove=capabilities.orders?.includes("APPROVE")===true;
  const canCreate=!contractsMode&&capabilities.orders?.includes("CREATE")===true;
  const canRecordSent=capabilities.orders?.includes("RECORD_SENT")===true;
  const canRecordResponse=capabilities.orders?.includes("RECORD_RESPONSE")===true;
  const canExport=capabilities.orders?.includes("EXPORT")===true;
  const canExportNow=canExport&&(selected?.status==="APPROVED"||(selected?.status==="PENDING"&&canApprove));
  const canRevise=!contractsMode&&(selected?.status==="REJECTED"||(selected?.status==="CLOSED"&&text(meta,"customerResponse")==="DECLINE"));
  const blockedSelfApproval=!!selected&&!!account.accountId&&selected.creator_id===account.accountId&&!account.canSelfApprove;
  const customerName=text(partner,"name")||selected?.customer||"Khách vãng lai";
  const sentAt=text(meta,"sentAt");
  const responseAt=text(meta,"responseAt");
  const orderBlockReason=(quote:Quote|null)=>!canCreate?"Bạn chưa có quyền tạo đơn bán."
    :quote?.status!=="APPROVED"?"Báo giá cần được duyệt trước khi tạo đơn."
    :text(quote?.metadata,"customerResponse")==="DECLINE"?"Khách đã từ chối báo giá."
    :"";
  const orderBlockedReason=orderBlockReason(selected);
  const canCollectDebt=contractsMode&&(account.salesRole===true||account.platformAdmin===true)&&num(selected??{},"debt_amount")>0;
  const contractTotals=contractsMode?rows.reduce((totals,row)=>({
    total:totals.total+num(row,"order_total"),
    paid:totals.paid+num(row,"paid_amount"),
    debt:totals.debt+num(row,"debt_amount")
  }),{total:0,paid:0,debt:0}):null;

  return <div className={contractsMode?"crm-quotes contracts-dashboard":"crm-quotes"}>
    <div className="p-title"><div><h1>{contractsMode?"Quản lý hợp đồng":"Báo giá"}</h1><p>{contractsMode?"Theo dõi hợp đồng từ dữ liệu báo giá của module Bán hàng phục vụ nghiệp vụ Kế toán.":"Danh sách báo giá sản phẩm và kết quả sau khi duyệt."}</p></div>{canCreate&&<Button type="button" disabled={busy} onClick={()=>setComposerOpen(true)}><Plus aria-hidden="true"/>Tạo báo giá</Button>}</div>
    {contractTotals&&<div className="p-metrics compact contract-metrics" aria-label="Tổng quan công nợ hợp đồng"><div className="p-metric contract-metric contract-metric-total"><span>Tổng tiền đơn hàng</span><strong>{money(contractTotals.total)}</strong><small>Theo các đơn bán đã lập</small></div><div className="p-metric contract-metric contract-metric-paid"><span>Đã thu khách hàng</span><strong>{money(contractTotals.paid)}</strong><small>Tổng khoản thu đã ghi nhận</small></div><div className="p-metric contract-metric contract-metric-debt"><span>Còn ghi nợ</span><strong>{money(contractTotals.debt)}</strong><small>Công nợ còn mở</small></div></div>}
    <section className="p-panel">
      <div className="p-table-toolbar">
        <input value={q} onChange={event=>setQ(event.target.value)} placeholder={contractsMode?"Tìm khách hàng, số báo giá hoặc số đơn bán...":"Tìm khách hàng, mã báo giá..."} aria-label={contractsMode?"Tìm hợp đồng mua bán":"Tìm báo giá"} />
        <select value={status} onChange={event=>setStatus(event.target.value)} aria-label="Lọc trạng thái">
          {contractsMode?<><option value="">Tất cả trạng thái đơn hàng</option><option value="APPROVED">Đã xác nhận</option><option value="PARTIAL">Đã xuất một phần</option><option value="COMPLETE">Đã xuất đủ</option><option value="CLOSED">Đã đóng</option><option value="CANCELLED">Đã hủy</option></>:<><option value="">Tất cả trạng thái</option><option value="PENDING">Chờ duyệt</option><option value="APPROVED">Đã duyệt</option><option value="REJECTED">Từ chối</option><option value="CLOSED">Khách yêu cầu bản mới</option></>}
        </select>
      </div>
      <CrmTable aria-label={contractsMode?"Danh sách hợp đồng mua bán":"Danh sách báo giá"} indexColumn actionsColumn minWidth={contractsMode?1250:1100} aria-busy={loading} headers={contractsMode?["STT","Khách hàng","Báo giá gốc","Đơn bán",{label:"Giá trị",align:"right"},{label:"Đã thu",align:"right"},{label:"Còn nợ",align:"right"},{label:"Trả trước",align:"right"},"Trạng thái đơn hàng","Thao tác"]:["STT","Khách hàng","Nhóm","Sản phẩm",{label:"Giá trị",align:"right"},"Kết quả sau khi duyệt","Người tạo","Trạng thái","Thao tác"]}>
        {loading?<tr><td colSpan={contractsMode?10:9}>{contractsMode?"Đang tải hợp đồng…":"Đang tải báo giá…"}</td></tr>:rows.length===0?<tr><td colSpan={contractsMode?10:9}>{contractsMode?"Chưa có báo giá nào đã chuyển thành đơn bán.":"Chưa có báo giá."}</td></tr>:rows.map((row,index)=><tr key={row.id}>
          {contractsMode?<><td>{index+1}</td><td><strong>{row.customer||"Khách vãng lai"}</strong><small>{row.customer_group||"—"}</small></td><td><strong>{row.number||"—"}</strong><small>{row.pipeline_type==="EPC"?"EPC":"Báo giá đã duyệt"}</small></td><td><strong>{row.order_number||"—"}</strong><small>{timestamp(row.order_created_at)}</small></td><td data-align="right">{money(row.order_total)}</td><td data-align="right">{money(row.paid_amount)}</td><td data-align="right">{money(row.debt_amount)}</td><td data-align="right">{money(row.prepaid_amount)}</td><td><span className={`crm-quote-status ${(row.order_status||"").toLowerCase()}`}>{orderStatusLabel(row.order_status)}</span></td><td><div className="flex items-center justify-end gap-2"><Button type="button" variant="outline" size="sm" disabled={busy} aria-label={`Xem hồ sơ hợp đồng ${row.number||row.id}`} onClick={()=>void openDetail(row)}><Eye aria-hidden="true"/>Xem hồ sơ</Button></div></td></>:<><td>{index+1}</td><td><strong>{row.customer||"Khách vãng lai"}</strong><small>{row.number||"—"}{row.pipeline_type==="EPC"?" · EPC":""}</small></td><td>{row.customer_group||"—"}</td><td>{row.products||"—"}</td><td data-align="right">{money(row.total)}</td><td>{row.approval_result||"—"}</td><td>{row.creator||"—"}</td><td><span className={`crm-quote-status ${(row.status||"").toLowerCase()}`}>{statusLabel(row.status)}</span></td><td><div className="flex items-center justify-end gap-2"><Button type="button" variant="outline" size="sm" disabled={busy} aria-label={`Xem chi tiết báo giá ${row.number||row.id}`} onClick={()=>void openDetail(row)}><Eye aria-hidden="true"/>Xem chi tiết</Button></div></td></>}
        </tr>)}
      </CrmTable>
    </section>
    {conversionQuote&&<div className="resource-scope-modal quote-detail-modal quote-conversion-modal" role="presentation">
      <section role="dialog" aria-modal="true" aria-label="Chuyển báo giá thành đơn hàng">
        <header><div className="quote-conversion-heading"><span className="quote-conversion-icon"><ShoppingCart aria-hidden="true"/></span><div><h2>Chuyển thành đơn hàng</h2><p>Báo giá {conversionQuote.number}</p></div></div><Button type="button" variant="ghost" size="icon" disabled={busy} onClick={()=>setConversionQuote(null)} aria-label="Đóng"><X aria-hidden="true"/></Button></header>
        <form onSubmit={event=>{event.preventDefault();const submitter=(event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement|null;void (submitter?.value==="decline"?declineCustomerQuote():confirmCustomerAndConvert());}}>
          <div className="quote-detail-body">
            {conversionError&&<div className="quote-detail-alert" role="alert">{conversionError}</div>}
            <div className="quote-conversion-notice"><h3>Ghi nhận phản hồi của khách hàng</h3><p>Khách đồng ý: tạo đơn, xuất kho trừ tồn và tự tạo vận đơn GHN. Khách không đồng ý: đóng báo giá, không tạo đơn hàng. Hệ thống lưu người xác nhận và thời gian.</p></div>
            {!text(conversionQuote.metadata,"sentAt")&&<div className="quote-review-grid"><label><span>Kênh đã trao đổi</span><select disabled={busy} value={conversionInput.channel} onChange={event=>setConversionInput(value=>({...value,channel:event.target.value}))}><option value="PHONE">Điện thoại / trực tiếp</option><option value="ZALO">Zalo</option><option value="EMAIL">Email</option><option value="OTHER">Khác</option></select></label><label><span>Khách đã trao đổi *</span><input required maxLength={160} disabled={busy} value={conversionInput.recipient} onChange={event=>setConversionInput(value=>({...value,recipient:event.target.value}))}/></label></div>}
            {conversionShipping&&<QuoteShippingFields quote={conversionQuote} request={request} value={conversionShipping} onChange={setConversionShipping} disabled={busy}/>}
            <label><span>Ghi chú xác nhận <small>(không bắt buộc)</small></span><textarea rows={3} placeholder="Nội dung đã thống nhất với khách hàng…" maxLength={1000} disabled={busy} value={conversionInput.note} onChange={event=>setConversionInput(value=>({...value,note:event.target.value}))}/></label>
          </div>
          <footer><Button type="button" variant="ghost" disabled={busy} onClick={()=>setConversionQuote(null)}>Đóng</Button><Button type="submit" formNoValidate name="decision" value="decline" variant="outline" className="quote-conversion-decline" disabled={busy||text(conversionQuote.metadata,"customerResponse")==="ACCEPTED"}>{pendingAction==="response"?"Đang ghi nhận…":"Khách không đồng ý"}</Button><Button type="submit" name="decision" value="accept" disabled={busy}>{pendingAction==="order"?"Đang chuyển…":"Đồng ý — Xuất kho & tạo GHN"}</Button></footer>
        </form>
      </section>
    </div>}
    {selected&&!conversionQuote&&<div className="resource-scope-modal quote-detail-modal" role="presentation" onMouseDown={event=>{if(event.target===event.currentTarget&&!busy)closeDetail();}}>
      <section role="dialog" aria-modal="true" aria-label="Chi tiết báo giá">
        <header>
          <h2>{contractsMode?"Hồ sơ hợp đồng mua bán":"Thông tin báo giá"}</h2>
          <div className="quote-detail-head-side">
            <span className={`crm-quote-status ${(selected.status||"").toLowerCase()}`}>{statusLabel(selected.status)}</span>
            <Button type="button" variant="ghost" size="icon" disabled={busy} onClick={closeDetail} aria-label="Đóng"><X aria-hidden="true"/></Button>
          </div>
        </header>
        <div className="quote-detail-body">
          {detailError&&<div className="quote-detail-alert" role="alert">{detailError}</div>}
          {contractsMode&&<section className="quote-review quote-review-done"><h3>Tiến độ thực hiện đơn hàng</h3><p><strong>{selected.order_number||"—"}</strong> · {orderStatusLabel(selected.order_status)}</p><small>Hợp đồng lấy nội dung và file từ báo giá {selected.number}; trạng thái thực hiện được đồng bộ từ đơn bán liên kết.</small>{canCollectDebt&&<div className="contract-debt-action"><span>Còn phải thu <strong>{money(selected.debt_amount)}</strong></span><Button type="button" className="primary contract-debt-button" disabled={busy} aria-label={`Thu nợ ${money(selected.debt_amount)} của hợp đồng ${selected.number||selected.id}`} onClick={()=>{sessionStorage.setItem("retail.debt-focus",JSON.stringify({orderId:selected.order_id,orderNumber:selected.order_number,partnerId:selected.partner_id,amount:selected.debt_amount}));onNavigate?.("retail-debt");}}><HandCoins aria-hidden="true"/>Thu nợ</Button></div>}</section>}
          {contractsMode&&<section className="contract-payment-history"><h3>Lịch sử Sales thu tiền <span>{collectionHistory.length} lần</span></h3>{collectionHistory.length===0?<p>Chưa có khoản thu nào được ghi nhận cho hợp đồng.</p>:<ol>{collectionHistory.map(payment=><li key={text(payment,"id")}><div className="contract-payment-main"><div><strong>{text(payment,"collection_type")==="PREPAYMENT"?"Khách trả trước":"Thu nợ khách hàng"}</strong><small>{text(payment,"actor_name")||"Hệ thống"} · {paymentMethodLabel(text(payment,"method"))}</small></div><div><b>{money(num(payment,"amount"))}</b><time>{timestamp(payment.created_at)}</time></div></div>{text(payment,"reference")&&<p>{text(payment,"reference")}</p>}</li>)}</ol>}</section>}
          {contractsMode&&<section className="contract-order-history"><h3>Lịch sử thay đổi đơn hàng <span>{orderEvents.length} sự kiện</span></h3>{orderEvents.length===0?<p>Chưa có thay đổi nào được ghi nhận.</p>:<ol>{orderEvents.map(event=><li key={text(event,"id")}><div><strong>{orderEventLabel(text(event,"event_type"))}</strong><time>{timestamp(event.created_at)}</time></div><small>{text(event,"actor_name")||"Hệ thống"}</small>{text(event,"reason")&&<p>{text(event,"reason")}</p>}</li>)}</ol>}</section>}
          {!contractsMode&&!isCeo&&canCreate&&text(meta,"pipelineType")!=="EPC"&&<section className="quote-review">
            <h3>Tạo đơn bán hàng <span>Giữ giá và các mặt hàng theo báo giá khách đã đồng ý</span></h3>
            <div className="quote-review-actions"><Button type="button" disabled={busy||!canCreate||selected.status!=="APPROVED"} aria-describedby={orderBlockedReason?"quote-order-blocked":undefined} aria-busy={pendingAction==="order"} onClick={()=>void createOrder()}>{pendingAction==="order"?"Đang tạo đơn…":"Chuyển thành đơn hàng"}</Button></div>
            {orderBlockedReason&&<p id="quote-order-blocked">{orderBlockedReason}</p>}
          </section>}
          {text(meta,"pipelineType")==="EPC"&&<section className="quote-review"><h3>Báo giá dự án EPC</h3><p>Báo giá này liên kết với cơ hội EPC. Sau khi khách đồng ý, hoàn thiện và xác nhận hợp đồng tại CRM → Cơ hội → Dự án EPC.</p>{!contractsMode&&selected.status==="APPROVED"&&sentAt&&!responseAt&&canRecordResponse&&<Button type="button" disabled={busy} onClick={()=>void recordResponse("ACCEPTED")}>Ghi nhận khách đồng ý báo giá EPC</Button>}{text(meta,"customerResponse")==="ACCEPTED"&&<p>Đã ghi nhận khách đồng ý.</p>}</section>}
          {selected.status!=="PENDING"&&(text(review,"note")||text(selected,"reason"))&&<section className="quote-review quote-review-done">
            <h3>Kết quả sau khi duyệt</h3>
            <p>{text(review,"note")||text(selected,"reason")}</p>
            <small>{text(review,"at")?`Quyết định lúc ${timestamp(review.at)}`:selected.approval_result||""}</small>
          </section>}
          <div className="quote-detail-groups">
            <section className="quote-fact-group">
              <h3>Khách hàng</h3>
              <dl className="quote-detail-facts">
                <div><dt>Khách hàng</dt><dd><strong>{customerName}</strong>{text(partner,"code")&&<small>Mã {text(partner,"code")}</small>}{text(partner,"customer_group")&&<small>{text(partner,"customer_group")}</small>}</dd></div>
                <div><dt>Liên hệ</dt><dd>{text(partner,"phone")||"—"}{text(partner,"email")&&<small>{text(partner,"email")}</small>}</dd></div>
                {text(partner,"entity_type")==="BUSINESS"&&text(partner,"customer_group")!=="CUSTOMER_OFFICIAL"&&selected.customer_group!=="CUSTOMER_OFFICIAL"&&<><div><dt>Công ty</dt><dd>{text(partner,"company_name")||"—"}{text(partner,"company_address")&&<small>{text(partner,"company_address")}</small>}</dd></div>
                <div><dt>Mã số thuế</dt><dd>{text(partner,"tax_code")||"—"}</dd></div></>}
              </dl>
            </section>
            <section className="quote-fact-group">
              <h3>Giao hàng &amp; hồ sơ</h3>
              <dl className="quote-detail-facts">
                <div><dt>Địa chỉ công trình</dt><dd>{text(meta,"address")||text(partner,"shipping_address")||text(partner,"address")||"—"}</dd></div>
                <div><dt>Hiệu lực báo giá</dt><dd>{text(meta,"validUntil")||"—"}</dd></div>
                <div><dt>Người tạo báo giá</dt><dd>{selected.creator||"—"}<small>Thời gian tạo {timestamp(selected.created_at)}</small></dd></div>
              </dl>
            </section>
            {text(meta,"description")&&<section className="quote-fact-group"><h3>Hệ điện</h3><dl className="quote-detail-facts"><div><dt>Mô tả hệ thống</dt><dd>{text(meta,"description")}</dd></div></dl></section>}
            {text(meta,"monthlySaving")&&<section className="quote-fact-group"><h3>Tiết kiệm</h3><dl className="quote-detail-facts"><div><dt>Tiền điện 1 tháng</dt><dd>{text(meta,"monthlySaving")}</dd></div></dl></section>}
          </div>
          {Array.isArray(meta.quoteOnlyLines)&&meta.quoteOnlyLines.length>0&&<section className="quote-detail-lines"><h3>Sản phẩm phát sinh <span>{meta.quoteOnlyLines.length} dòng</span></h3><ul className="quote-only-detail">{(meta.quoteOnlyLines as Row[]).map((item,index)=><li key={index}><strong>{text(item,"name")}</strong><small>{text(item,"qty")} {text(item,"unit")} · {money(num(item,"price"))}</small></li>)}</ul></section>}
          <section className="quote-detail-lines">
            <h3>Sản phẩm báo giá <span>{detailLines.length} dòng</span></h3>
            {detailLines.length===0?<p className="quote-detail-empty">Không có dòng sản phẩm trong báo giá này.</p>:<CrmTable aria-label="Sản phẩm báo giá" framed minWidth={760} indexColumn>
              <thead><tr><th scope="col">STT</th><th scope="col">Sản phẩm</th><th scope="col" data-align="center">ĐVT</th><th scope="col" data-align="right">Số lượng</th><th scope="col" data-align="right">Đơn giá</th><th scope="col" data-align="right">Giảm</th><th scope="col" data-align="right">Thuế</th><th scope="col" data-align="right">Thành tiền</th></tr></thead>
              <tbody>{detailLines.map((line,index)=>{const snapshot=(line.sku_snapshot??{}) as Row;const priceReason=text((line.rule_snapshot??{}) as Row,"manualPriceReason");return <tr key={text(line,"id")||index}>
                <td>{index+1}</td>
                <td><strong>{text(snapshot,"name")||"—"}</strong><small>{[text(snapshot,"code"),text(snapshot,"variant")].filter(Boolean).join(" · ")||"—"}</small>{priceReason&&<small className="quote-line-reason">Giá nhập tay: {priceReason}</small>}</td>
                <td data-align="center">{text(line,"unit")||"—"}</td>
                <td data-align="right">{quantity(line.qty)}</td>
                <td data-align="right">{money(num(line,"price"))}</td>
                <td data-align="right">{money(num(line,"discount"))}</td>
                <td data-align="right">{money(num(line,"tax"))}</td>
                <td data-align="right">{money(num(line,"total"))}</td>
              </tr>;})}</tbody>
            </CrmTable>}
            <dl className="quote-detail-totals">
              <div><dt>Tiền hàng</dt><dd>{money(num(selected,"total")-num(selected,"fee"))}</dd></div>
              <div><dt>Phí vận chuyển</dt><dd>{money(selected.fee)}</dd></div>
              <div className="quote-detail-totals-grand"><dt>Tổng cộng</dt><dd>{money(selected.total)}</dd></div>
            </dl>
          </section>
          {canExportNow&&<section className="quote-files">
            <h3>Bản báo giá <span>{selected.status==="PENDING"?"Tải Excel/PDF để xem trước khi quyết định duyệt":"Excel hoặc PDF tải về máy"}</span></h3>
            <div className="quote-files-actions">
              <Button type="button" disabled={busy} aria-busy={pendingAction==="xlsx"} onClick={()=>void exportQuote("xlsx")}>{pendingAction==="xlsx"?"Đang xuất…":"Tải Excel"}</Button>
              <Button type="button" disabled={busy} aria-busy={pendingAction==="pdf"} onClick={()=>void exportQuote("pdf")}>{pendingAction==="pdf"?"Đang xuất…":"Tải PDF"}</Button>
              <Button type="button" disabled={busy} aria-busy={pendingAction==="pdf-preview"} onClick={()=>void exportQuote("pdf",true)}>{pendingAction==="pdf-preview"?"Đang mở…":"Xem PDF"}</Button>
            </div>
          </section>}
          {!contractsMode&&selected.status==="APPROVED"&&canRecordSent&&!sentAt&&<section className="quote-review">
            <h3>Ghi nhận gửi khách <span>Chỉ thực hiện sau khi báo giá được duyệt</span></h3>
            <div className="quote-review-grid"><label><span>Kênh gửi</span><select value={sendChannel} disabled={busy} onChange={event=>setSendChannel(event.target.value)}><option value="EMAIL">Email</option><option value="ZALO">Zalo</option><option value="PHONE">Điện thoại</option><option value="OTHER">Khác</option></select></label><label><span>Người nhận *</span><input value={sendRecipient||text(partner,"email")||text(partner,"phone")} disabled={busy} onChange={event=>setSendRecipient(event.target.value)} /></label></div>
            <div className="quote-review-actions"><Button type="button" disabled={busy||!(sendRecipient||text(partner,"email")||text(partner,"phone")).trim()} aria-busy={pendingAction==="send"} onClick={()=>void recordSent()}>{pendingAction==="send"?"Đang ghi nhận…":"Đã gửi cho khách"}</Button></div>
          </section>}
          {!contractsMode&&selected.status==="APPROVED"&&canRecordResponse&&sentAt&&!responseAt&&<section className="quote-review">
            <h3>Ghi nhận khách từ chối báo giá</h3>
            <label><span>Ghi chú khách từ chối / yêu cầu bản mới</span><input value={responseNote} maxLength={1000} disabled={busy} onChange={event=>setResponseNote(event.target.value)}/></label>
            <div className="quote-review-actions"><Button type="button" disabled={busy} aria-busy={pendingAction==="response"} onClick={()=>void recordResponse()}>{pendingAction==="response"?"Đang ghi nhận…":"Lưu phản hồi khách từ chối"}</Button></div>
          </section>}
          {!contractsMode&&selected.status==="PENDING"&&canApprove&&<section className="quote-review">
            <h3>Quyết định của Quản lý <span>Bắt buộc ghi lý do</span></h3>
            {text(selected,"reason")&&<p className="quote-detail-note"><span>Lý do Sales gửi duyệt</span>{text(selected,"reason")}</p>}
            <label><span>Lý do duyệt / từ chối *</span><textarea value={reviewNote} maxLength={1000} disabled={busy||blockedSelfApproval} placeholder="Nêu căn cứ duyệt giá, hoặc nội dung Sales cần chỉnh khi từ chối." onChange={event=>setReviewNote(event.target.value)} /></label>
            <div className="quote-review-actions">
              <Button type="button" disabled={busy||blockedSelfApproval||!reviewNote.trim()} aria-busy={pendingAction==="approve"} onClick={()=>void transition("approve")}>{pendingAction==="approve"?"Đang duyệt…":"Duyệt báo giá"}</Button>
              <Button type="button" variant="destructive" disabled={busy||blockedSelfApproval||!reviewNote.trim()} aria-busy={pendingAction==="reject"} onClick={()=>void transition("reject")}>{pendingAction==="reject"?"Đang gửi…":"Từ chối"}</Button>
            </div>
            {blockedSelfApproval&&<small>Báo giá do chính bạn lập; cần Quản lý khác quyết định.</small>}
          </section>}
          {text(selected,"note")&&<p className="quote-detail-note"><span>Ghi chú của Sales</span>{text(selected,"note")}</p>}
        </div>
        <footer>
          {canRevise&&<Button type="button" disabled={busy} onClick={()=>{const selectedMeta=(selected.metadata??{}) as Row;setComposerCustomerId(String(selected.partner_id??""));setComposerOpportunityId(text(selectedMeta,"opportunityId"));setComposerBranchId(String(selected.branch_id??""));setComposerOpen(true);}}>{selected.status==="CLOSED"?"Tạo bản mới theo phản hồi khách":"Tạo bản báo giá mới"}</Button>}
          <Button type="button" variant="outline" disabled={busy} onClick={closeDetail}>Đóng</Button>
        </footer>
      </section>
    </div>}
    {(composerOpen||composerCustomerId)&&<SalesWorkspace view="retail-orders" request={request} apiUrl={apiUrl} quoteComposerOnly openQuoteComposer={composerOpen&&!composerCustomerId} initialQuoteCustomerId={composerCustomerId} initialQuoteOpportunityId={composerOpportunityId} initialQuoteBranchId={composerBranchId} initialQuoteRevision={canRevise?selected||undefined:undefined} onQuoteComposerClose={closeQuoteComposer} onNavigate={()=>{}}/>}
  </div>;
}
