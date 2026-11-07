"use client";

import { hasPartnerRole } from "../partner-role";
import { cloneElement, isValidElement, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import PosEditor from "./pos-editor";
import OrderEditor from "./order-editor";
import { stockShortages } from "./pos-stock";
import QuoteShippingFields, { initialShipping, fulfillQuote, type ShippingInput } from "./quote-fulfillment";
import MoneyInput from "../money-input";
import { num, quantity, text, timestamp, today as vietnamDate, money } from "@/components/retail/shared/format";
import { toast } from "@/hooks/use-toast";
import { ChevronDown, ChevronLeft, ChevronRight, X } from "lucide-react";
import { CrmButton } from "../crm/crm-button";

export type Row = Record<string, unknown>;
type Request = <T>(path: string, init?: RequestInit) => Promise<T>;
export type Catalog = { canSelfApprove?:boolean; warehouses: Row[]; skus: Row[]; partners: Row[]; permissions: string[]; capabilities?: Record<string,string[]>; accountId: string };
export type Doc = Row & { id: string; type: string; status: string; version: number; lines: Row[]; openItems: Row[] };
type Page = { items: Row[]; total: number; page: number };
export type Line = { key: string; skuId: string; sourceLineId?: string; qty: string; unit: string; price: string; priceReason?: string; discount: string; vat: string; lot: string; expiry: string; serials: string; maxQty?: number };
export type Header = { warehouseId: string; partnerId: string; channel: string; fee: string; paid: string; method: string; address: string; systemDescription: string; monthlySaving: string; cod: string; validUntil: string; note: string; reason: string; taxInclusive: boolean };

const types: Record<string, string> = { POS: "Phiếu bán tại quầy", QUOTE: "Báo giá", SALE_ORDER: "Đơn bán hàng", ISSUE: "Phiếu xuất bán" };
const statuses: Record<string, string> = { DRAFT: "Nháp", PENDING: "Chờ duyệt", APPROVED: "Đã xác nhận", POSTED: "Đã ghi", PARTIAL: "Xuất một phần", COMPLETE: "Đã xuất đủ", CLOSED: "Đã đóng", REJECTED: "Từ chối", CANCELLED: "Đã hủy nháp", PREPARING: "Chuẩn bị giao", SHIPPING: "Đang giao", DELIVERED: "Đã giao", FAILED: "Giao thất bại" };
const channels: Record<string, string> = { SALES: "Sales", COUNTER: "Tại quầy", ONLINE: "Online nhập tay", WHOLESALE: "Bán buôn", COLLABORATOR: "Cộng tác viên" };
const methods: Record<string, string> = { CASH: "Tiền mặt", BANK: "Chuyển khoản", CARD: "Thẻ", OTHER: "Khác" };
const saleTypes = ["SALE_ORDER", "QUOTE", "ISSUE"];
function newHeader(warehouseId: string, type = "SALE_ORDER"): Header { const expiry = new Date(); expiry.setDate(expiry.getDate() + 7); return { warehouseId, partnerId: "", channel: type === "QUOTE" ? "SALES" : "COUNTER", fee: "0", paid: "0", method: "CASH", address: "", systemDescription: "", monthlySaving: "", cod: "0", validUntil: new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit" }).format(expiry), note: "", reason: "", taxInclusive: false }; }function Badge({ value, delivery = false }: { value: unknown; delivery?: boolean }) { const key = String(value); return <span className={`s-badge s-badge-${key.toLowerCase()}`}>{key === "PARTIAL" && delivery ? "Giao một phần" : statuses[key] ?? key}</span>; }
function Field({ label, children, hint, error }: { label: string; children: ReactNode; hint?: ReactNode; error?: string }) { return <label className={error ? "s-field s-field-invalid" : "s-field"}><span>{label}</span>{isValidElement<{ "aria-label"?: string }>(children) ? cloneElement(children, { "aria-label": label }) : children}{error ? <small className="s-field-error">{error}</small> : hint && <small>{hint}</small>}</label>; }
function Table({
  headings,
  children,
}: {
  headings: string[];
  children: ReactNode;
}) {
  return (
    <div className="s-table-wrap">
      <table>
        <thead>
          <tr>
            {headings.map((h) => (
              <th key={h} scope="col">
                {h}
              </th>
            ))}
            </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
function Dialog({ title, children, onClose, locked, wide = false, quoteComposerOnly = false }: { title: string; children: ReactNode; onClose: () => void; locked: boolean; wide?: boolean; quoteComposerOnly?: boolean }) { const ref = useRef<HTMLDivElement>(null); useEffect(() => { const prior = document.activeElement as HTMLElement | null; ref.current?.focus(); return () => prior?.focus(); }, []); return <div className="s-backdrop" onKeyDown={e => { if (e.key === "Escape" && !locked) onClose(); if (e.key === "Tab") { const elements = ref.current?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex="0"]'); if (!elements?.length) return; const first = elements[0], last = elements[elements.length - 1]; if (e.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); } } }}><div className={`s-dialog${wide ? " s-dialog-wide" : ""}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref}><header><h2>{title}</h2>{quoteComposerOnly ? <CrmButton type="button" variant="ghost" size="icon" disabled={locked} onClick={onClose} aria-label="Đóng biểu mẫu"><X aria-hidden="true" /></CrmButton> : <button type="button" disabled={locked} onClick={onClose} aria-label="Đóng biểu mẫu">×</button>}</header>{children}</div></div>; }

export default function SalesWorkspace({ view, request, apiUrl = "", onNavigate, quoteComposerOnly = false, openQuoteComposer = false, initialQuoteCustomerId, initialQuoteOpportunityId, initialQuoteBranchId, initialQuoteRevision, onQuoteComposerClose }: { view: string; request: Request; apiUrl?: string; onNavigate: (view: string) => void; quoteComposerOnly?: boolean; openQuoteComposer?: boolean; initialQuoteCustomerId?: string; initialQuoteOpportunityId?: string; initialQuoteBranchId?: string; initialQuoteRevision?: Row; onQuoteComposerClose?: () => void }) {
  const ActionButton = quoteComposerOnly ? CrmButton : "button";
  const pos = view === "retail-pos";
  const [catalog, setCatalog] = useState<Catalog | null>(null), [stock, setStock] = useState<Row[]>([]);
  const [list, setList] = useState<Page>({ items: [], total: 0, page: 0 }), [kind, setKind] = useState(quoteComposerOnly ? "QUOTE" : pos ? "POS" : "SALE_ORDER"), [status, setStatus] = useState(""), [query, setQuery] = useState(""), [search, setSearch] = useState(""), [page, setPage] = useState(0);
  const [productPageSize, setProductPageSize] = useState(25), [productPage, setProductPage] = useState(0);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [detail, setDetail] = useState<Doc | null>(null), [editor, setEditor] = useState(pos), [formType, setFormType] = useState(pos ? "POS" : "SALE_ORDER"), [source, setSource] = useState<Doc | null>(null);
  const [header, setHeader] = useState<Header>(newHeader("")), [lines, setLines] = useState<Line[]>([]), [quoteOnlyLines, setQuoteOnlyLines] = useState<{ key: string; name: string; unit: string; qty: string; price: string }[]>([]), [quoteOnlyDraft, setQuoteOnlyDraft] = useState({ name: "", unit: "cái", qty: "1", price: "" }), [productTab, setProductTab] = useState<"stock" | "custom">("stock"), [productSearch, setProductSearch] = useState(""), [cartSearch, setCartSearch] = useState(""), [editorTab, setEditorTab] = useState<"items" | "delivery">("items"), [draft, setDraft] = useState<Doc | null>(null);
  const [finance, setFinance] = useState<{ payments: Row[]; openItems: Row[] }>({ payments: [], openItems: [] }), [deliveries, setDeliveries] = useState<Row[]>([]);
  const [dialog, setDialog] = useState(""), [actionForm, setActionForm] = useState<Record<string, string>>({}), [priceInfo, setPriceInfo] = useState<Record<string, Row>>({});
  const [uncertainCreate, setUncertainCreate] = useState(false), [issues, setIssues] = useState<Row[]>([]);
  const [expandedQuoteLines, setExpandedQuoteLines] = useState<Record<string, boolean>>({});
  const [showHistory, setShowHistory] = useState(false);
  const [selectingOrderQuote, setSelectingOrderQuote] = useState(false);
  const [acceptanceQuote, setAcceptanceQuote] = useState<Doc | null>(null);
  const [acceptanceShipping,setAcceptanceShipping] = useState<ShippingInput|null>(null);
  const [acceptanceInput, setAcceptanceInput] = useState({ channel: "PHONE", recipient: "", note: "" });
  const [customerForm, setCustomerForm] = useState<Record<string, string> | null>(null), [customerSearch, setCustomerSearch] = useState("");
  const [quoteOpportunities, setQuoteOpportunities] = useState<Row[]>([]), [quoteCareCustomers, setQuoteCareCustomers] = useState<Row[]>([]), [pendingQuoteCustomerIds, setPendingQuoteCustomerIds] = useState<Set<string>>(new Set()), [quoteEligibilityLoading, setQuoteEligibilityLoading] = useState(quoteComposerOnly);
  const [orderPrices, setOrderPrices] = useState<{ signature: string; items: Record<string, Row>; error: string }>({ signature: "", items: {}, error: "" });
  const createPayload = useRef<unknown>(null);
  const commandKeys = useRef(new Map<string, string>()), inFlight = useRef(false), generation = useRef(0);
  const launchedQuoteCustomer = useRef(""), launchedQuoteRevision = useRef("");
  const featureFor=(type:string)=>type==="POS"?"pos":type==="ISSUE"?"issue":"orders";
  const allowed=(feature:string,action:string)=>catalog?.capabilities ? !!catalog.capabilities[feature]?.includes(action) : catalog?.permissions.includes(action==="APPROVE"?"APPROVE":action==="EXPORT"?"EXPORT":"SELL")??false;
  const can = (permission: string) => catalog?.capabilities ? permission==="READ" ? true : permission==="SELL" ? allowed(featureFor(formType),"CREATE") : permission==="APPROVE" ? allowed(featureFor(detail?.type??formType),"APPROVE") : permission==="FINANCE" ? allowed("receipt","CREATE") : permission==="EXPORT" ? allowed(featureFor(kind),"EXPORT") : catalog.permissions.includes(permission) : catalog?.permissions.includes(permission) ?? false;
  const command = async <T,>(path: string, body: unknown): Promise<T> => { const payload = JSON.stringify(body), identity = path + payload; let key = commandKeys.current.get(identity); if (!key) { key = crypto.randomUUID(); commandKeys.current.set(identity, key); } const result = await request<T>("/api/v1/retail" + path, { method: "POST", headers: { "Idempotency-Key": key }, body: payload }); commandKeys.current.delete(identity); return result; };
  const load = useCallback(async () => {
    const id = ++generation.current; setLoading(true); setError("");
    try {
      const catalogTask = request<Catalog>("/api/v1/retail/catalog").then(cat => { if (!quoteComposerOnly && id === generation.current) setCatalog(cat); return cat; });
      const [cat, documents, balances] = await Promise.all([
        catalogTask,
        quoteComposerOnly ? Promise.resolve<Page>({ items: [], total: 0, page: 0 }) : request<Page>(`/api/v1/retail/documents?type=${kind}&status=${status}&q=${encodeURIComponent(search)}&page=${page}`),
        request<Row[]>("/api/v1/retail/stock")
      ]);
      if (id !== generation.current) return;
      setCatalog(cat); setStock(balances); setList(documents);
      setHeader(h => ({ ...h, warehouseId: cat.warehouses.some(w => text(w, "id") === h.warehouseId && w.active) ? h.warehouseId : text(cat.warehouses.find(w => w.active) ?? {}, "id") }));
    }
    catch (e) { if (id === generation.current) setError(e instanceof Error ? e.message : "Không thể tải dữ liệu bán hàng."); }
    finally { if (id === generation.current) setLoading(false); }
  }, [request, kind, status, search, page, quoteComposerOnly]);
  useEffect(() => {
    void load();
    // This ref is a request counter, not a DOM node; invalidate the latest request on cleanup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => { generation.current++; };
  }, [load]);
  useEffect(() => {
    if (!catalog || !editor || formType !== "QUOTE") return;
    let active = true;
    setQuoteEligibilityLoading(true);
    Promise.all([
      request<{ items?: Row[] }>("/api/v1/retail/crm/opportunities?q=&stage=&page=0"),
      request<{ items?: Row[] }>("/api/v1/retail/customers/assigned?q=&page=0&size=200&status="),
      request<Page>("/api/v1/retail/documents?type=QUOTE&status=PENDING&q=&page=0")
    ]).then(([opportunities, caredCustomers, pendingQuotes]) => {
      if (!active) return;
      setQuoteOpportunities(opportunities.items ?? []);
      setQuoteCareCustomers(caredCustomers.items ?? []);
      setPendingQuoteCustomerIds(new Set((pendingQuotes.items ?? []).map(quote => text(quote, "partner_id")).filter(Boolean)));
    }).catch(error => {
      if (!active) return;
      setQuoteOpportunities([]);
      setQuoteCareCustomers([]);
      setPendingQuoteCustomerIds(new Set());
      setError(error instanceof Error ? error.message : "Không tải được khách hàng đang chăm sóc.");
    }).finally(() => { if (active) setQuoteEligibilityLoading(false); });
    return () => { active = false; };
  }, [catalog, editor, formType, request]);
  const orderPriceSignature = JSON.stringify({ warehouseId: header.warehouseId, partnerId: header.partnerId, channel: header.channel, lines: lines.map(l => ({ key: l.key, skuId: l.skuId, qty: l.qty, unit: l.unit })) });
  useEffect(() => {
    if (!catalog || !editor || !["SALE_ORDER", "QUOTE"].includes(formType) || source || draft || !header.warehouseId) return;
    let active = true;
    const timer = setTimeout(() => {
      const input = JSON.parse(orderPriceSignature) as { warehouseId: string; partnerId: string; channel: string; lines: Line[] };
      void Promise.all(input.lines.map(async l => {
        const sku = catalog.skus.find(s => text(s, "id") === l.skuId) ?? {}, ratio = l.unit === text(sku, "unit") ? 1 : Number(((sku.units ?? {}) as Row)[l.unit]);
        if (!Number.isFinite(Number(l.qty)) || Number(l.qty) <= 0 || !ratio) return [l.key, {}] as const;
        return [l.key, await request<Row>("/api/v1/retail/price", { method: "POST", body: JSON.stringify({ skuId: l.skuId, warehouseId: input.warehouseId, partnerId: input.partnerId || undefined, channel: input.channel, qty: Number(l.qty) * ratio }) })] as const;
      })).then(entries => { if (active) setOrderPrices({ signature: orderPriceSignature, items: Object.fromEntries(entries), error: "" }); }).catch(e => { if (active) setOrderPrices({ signature: orderPriceSignature, items: {}, error: e instanceof Error ? e.message : "Chưa tải được giá bán." }); });
    }, 200);
    return () => { active = false; clearTimeout(timer); };
  }, [catalog, editor, formType, source, draft, header.warehouseId, orderPriceSignature, request]);
  const quickCustomer = async () => {
    if (!customerForm) return;
    if (!customerForm.code.trim() || !customerForm.name.trim()) throw new Error("Nhập mã và tên khách hàng.");
    const customer = await command<Row>("/customers/quick-create", customerForm);
    setCatalog(c => c ? { ...c, partners: [...c.partners.filter(p => p.id !== customer.id), customer] } : c);
    setHeader(h => ({ ...h, partnerId: text(customer, "id"), address: text(customer, "shipping_address") || text(customer, "address") }));
    setCustomerSearch(""); setCustomerForm(null); toast.success("Đã thêm và chọn khách hàng " + text(customer, "name") + ".");
  };
  const run = async <T,>(work: () => Promise<T>) => { if (inFlight.current) return; inFlight.current = true; setBusy(true); setError(""); try { await work(); } catch (e) { setError(e instanceof Error ? e.message : "Thao tác chưa hoàn tất. Tra lại phiếu trước khi thử lại."); } finally { setBusy(false); inFlight.current = false; } };
  const openDetail = async (id: string) => {
    const d = await request<Doc>("/api/v1/retail/documents/" + id); setDetail(d); setFinance({ payments: [], openItems: [] }); setDeliveries([]); setIssues([]);
    const related = await Promise.allSettled([request<Row[]>("/api/v1/retail/deliveries"), ...(can("FINANCE") ? [request<{ payments: Row[]; openItems: Row[] }>("/api/v1/retail/finance")] : [])]);
    if (related[0].status === "fulfilled") setDeliveries(related[0].value as Row[]);
    if (related[1]?.status === "fulfilled") setFinance(related[1].value as { payments: Row[]; openItems: Row[] });
    if (related.some(r => r.status === "rejected")) setError("Đã mở phiếu; chưa tải đủ dữ liệu giao hàng/thu tiền. Mở lại chi tiết để thử lại.");
    if (d.type === "SALE_ORDER") {
      const children: Row[] = []; let next = 0, total = 1;
      while (next * 50 < total) { const batch = await request<Page>(`/api/v1/retail/documents?type=ISSUE&page=${next}`); children.push(...batch.items.filter(child => (text(child, "source_id") === d.id || text(child, "sales_order_id") === d.id))); total = batch.total; next++; }
      setIssues(children);
    }
  };
  const start = useCallback((type: string, original?: Doc) => { if (pos && type === "POS") setDetail(null); setFormType(type); setSource(original ?? null); setDraft(null); createPayload.current = null; setUncertainCreate(false); setPriceInfo({}); setExpandedQuoteLines({}); setLines(original ? original.lines.filter(l => type !== "ISSUE" || num(l, "base_qty") > num(l, "progress") + num(l, "closed_qty")).map(l => ({ key: crypto.randomUUID(), skuId: text(l, "sku_id"), sourceLineId: text(l, "id"), qty: String(type === "ISSUE" ? (num(l, "base_qty") - num(l, "progress") - num(l, "closed_qty")) / num(l, "ratio") : num(l, "qty")), maxQty: type === "ISSUE" ? (num(l, "base_qty") - num(l, "progress") - num(l, "closed_qty")) / num(l, "ratio") : undefined, unit: text(l, "unit"), price: text(l, "price"), discount: type === "QUOTE" ? String(num(l, "discount")) : "", vat: text(l, "vat"), priceReason: type === "QUOTE" ? text((l.rule_snapshot ?? {}) as Row, "manualPriceReason") : undefined, lot: "", expiry: "", serials: "" })) : []); const h = newHeader(header.warehouseId, type); if (original) { h.warehouseId = text(original, "warehouse_id") || h.warehouseId; h.partnerId = text(original, "partner_id"); h.channel = type === "QUOTE" ? "SALES" : text(original, "channel"); const meta = (original.metadata ?? {}) as Row; h.address = text(meta, "address"); h.systemDescription = text(meta, "description"); h.monthlySaving = text(meta, "monthlySaving"); h.fee = "0"; h.note = "Từ " + text(original, "number"); } setHeader(h); const loaded = type === "QUOTE" && original ? ((original.metadata ?? {}) as Row).quoteOnlyLines : []; setQuoteOnlyLines(Array.isArray(loaded) ? (loaded as Row[]).map(item => ({ key: crypto.randomUUID(), name: text(item, "name"), unit: text(item, "unit") || "cái", qty: String(item.qty ?? ""), price: String(item.price ?? "") })) : []); setQuoteOnlyDraft({ name: "", unit: "cái", qty: "1", price: "" }); setEditorTab("items"); setEditor(true); setError(""); }, [header.warehouseId, pos]);
  useEffect(() => {
    if (!catalog || initialQuoteRevision || !initialQuoteCustomerId || launchedQuoteCustomer.current === initialQuoteCustomerId) return;
    launchedQuoteCustomer.current = initialQuoteCustomerId;
    const customer = catalog.partners.find(partner => text(partner, "id") === initialQuoteCustomerId && hasPartnerRole(partner, "CUSTOMER"));
    if (!customer) { toast.destructive({ title: "Không thể mở báo giá", description: "Khách hàng không còn trong danh sách khách hàng được phép chọn." }); onQuoteComposerClose?.(); return; }
    start("QUOTE");
    setKind("QUOTE");
    setPage(0);
    setHeader(current => ({ ...current, warehouseId: text(catalog.warehouses.find(warehouse => warehouse.active && (!initialQuoteBranchId || text(warehouse,"branch_id")===initialQuoteBranchId)) ?? {}, "id"), partnerId: initialQuoteCustomerId, address: text(customer, "shipping_address") || text(customer, "address") }));
  }, [catalog, initialQuoteCustomerId, initialQuoteOpportunityId, initialQuoteBranchId, initialQuoteRevision, onQuoteComposerClose, start]);
  useEffect(() => {
    const revisionId = text(initialQuoteRevision ?? {}, "id");
    if (!catalog || !initialQuoteRevision || !revisionId || launchedQuoteRevision.current === revisionId) return;
    launchedQuoteRevision.current = revisionId;
    start("QUOTE", initialQuoteRevision as Doc);
    setKind("QUOTE");
    setPage(0);
  }, [catalog, initialQuoteRevision, start]);
  useEffect(() => {
    if (!catalog || !openQuoteComposer || initialQuoteCustomerId || launchedQuoteCustomer.current === "__direct__") return;
    launchedQuoteCustomer.current = "__direct__";
    start("QUOTE");
    setKind("QUOTE");
    setPage(0);
  }, [catalog, openQuoteComposer, initialQuoteCustomerId, start]);
  const updateHeader = <K extends keyof Header>(key: K, value: Header[K]) => { const partner = key === "partnerId" ? catalog?.partners.find(p => text(p, "id") === value) ?? {} : {}; setHeader(h => ({ ...h, [key]: value, ...(key === "partnerId" ? { address: text(partner, "shipping_address") || text(partner, "address") } : {}) })); setPriceInfo({}); setError(""); };
  const updateLine = (key: string, field: keyof Line, value: string) => { setError(""); setLines(ls => ls.map(l => l.key === key ? { ...l, [field]: value } : l)); setPriceInfo({}); };
  const addSku = (sku: Row) => { const existing = lines.find(l => l.skuId === text(sku, "id") && l.unit === text(sku, "unit")); if (existing && !source && text(sku, "tracking") === "NONE") updateLine(existing.key, "qty", String(Number(existing.qty) + 1)); else setLines(ls => [...ls, { key: crypto.randomUUID(), skuId: text(sku, "id"), qty: "1", unit: text(sku, "unit"), price: formType === "QUOTE" && num(sku, "price") > 0 ? String(num(sku, "price")) : "", discount: "", vat: text(sku, "vat"), lot: "", expiry: "", serials: "" }]); setPriceInfo({}); setCartSearch(""); };
  const available = (skuId: string) => stock.filter(s => text(s, "warehouse_id") === header.warehouseId && text(s, "sku_id") === skuId).reduce((sum, s) => sum + num(s, "available"), 0);
  const customers = (catalog?.partners ?? []).filter(p => p.active && hasPartnerRole(p, "CUSTOMER"));
  const caredCustomerIds = new Set(quoteCareCustomers.filter(customer => (!catalog?.accountId || text(customer, "owner_id") === catalog.accountId) && ["QUALIFIED", "QUOTED"].includes(text(customer, "care_state"))).map(customer => text(customer, "id")));
  const quoteOpportunityByCustomer = new Map<string, Row>();
  quoteOpportunities.filter(opportunity => {
    const partnerId = text(opportunity, "partner_id");
    return partnerId && (!catalog?.accountId || text(opportunity, "owner_id") === catalog.accountId) && caredCustomerIds.has(partnerId) && !["WON", "LOST"].includes(text(opportunity, "stage"));
  }).forEach(opportunity => { const partnerId = text(opportunity, "partner_id"); if (!quoteOpportunityByCustomer.has(partnerId)) quoteOpportunityByCustomer.set(partnerId, opportunity); });
  const quoteCustomers = customers.filter(customer => quoteOpportunityByCustomer.has(text(customer, "id")) || (Boolean(initialQuoteOpportunityId) && text(customer, "id") === initialQuoteCustomerId));
  const initialQuoteCustomerSelected = header.partnerId === initialQuoteCustomerId;
  const selectedQuoteOpportunity = (initialQuoteCustomerSelected ? initialQuoteOpportunityId : "") || text(quoteOpportunityByCustomer.get(header.partnerId) ?? {}, "id");
  const quoteBranchId = (initialQuoteCustomerSelected ? initialQuoteBranchId : "") || text(quoteOpportunityByCustomer.get(header.partnerId) ?? {}, "branch_id");
  const quoteWarehouses = useMemo(() => (catalog?.warehouses ?? []).filter(warehouse => warehouse.active && text(warehouse, "kind") !== "QUARANTINE" && (!quoteBranchId || text(warehouse, "branch_id") === quoteBranchId)), [catalog, quoteBranchId]);
  useEffect(() => {
    if (formType !== "QUOTE" || quoteWarehouses.some(warehouse => text(warehouse, "id") === header.warehouseId)) return;
    const warehouseId = text(quoteWarehouses[0] ?? {}, "id");
    if (warehouseId !== header.warehouseId) setHeader(current => ({ ...current, warehouseId }));
  }, [formType, header.warehouseId, quoteWarehouses]);
  const formWarehouses = formType === "QUOTE" ? quoteWarehouses : (catalog?.warehouses ?? []).filter(warehouse => warehouse.active);
  const quoteRevision = formType === "QUOTE" && !!source;
  const quotePending = formType === "QUOTE" && pendingQuoteCustomerIds.has(header.partnerId);
  const quoteProductsLoading = formType === "QUOTE" && (loading || quoteEligibilityLoading || (quoteWarehouses.length > 0 && !quoteWarehouses.some(warehouse => text(warehouse, "id") === header.warehouseId)));
  const matchingProducts = (catalog?.skus ?? []).filter(sku => sku.active && available(text(sku, "id")) > 0 && ["name", "code", "barcode", "variant"].some(key => text(sku, key).toLowerCase().includes(productSearch.trim().toLowerCase())));
  const productTotalPages = Math.max(1, Math.ceil(matchingProducts.length / productPageSize));
  const visibleProducts = matchingProducts.slice(productPage * productPageSize, (productPage + 1) * productPageSize);
  useEffect(() => { setProductPage(0); }, [productSearch, header.warehouseId, productPageSize]);
  useEffect(() => { if (productPage >= productTotalPages) setProductPage(Math.max(0, productTotalPages - 1)); }, [productPage, productTotalPages]);
  const selected = (id: string) => catalog?.skus.find(s => text(s, "id") === id) ?? {};
  const cartQuery = cartSearch.trim().toLowerCase();
  const lineProduct = (l: Line) => (source?.lines.find(sl => text(sl, "id") === l.sourceLineId)?.sku_snapshot as Row | undefined) ?? selected(l.skuId);
  const cartEntries = lines.map((line, index) => ({ line, index })).filter(({ line }) => !cartQuery || [text(lineProduct(line), "name"), text(lineProduct(line), "code"), text(lineProduct(line), "variant"), text(selected(line.skuId), "barcode"), line.unit].join(" ").toLowerCase().includes(cartQuery));
  const quotePreview = useMemo(() => {
    const result = lines.reduce((summary, line) => {
      const sku = selected(line.skuId);
      const quantityValue = Number(line.qty);
      const ratio = line.unit === text(sku, "unit") ? 1 : Number(((sku.units ?? {}) as Row)[line.unit]);
      const pricing = orderPrices.items[line.key] ?? priceInfo[line.key] ?? {};
      const policyPrice = (num(pricing, "price") || num(sku, "price")) * (Number.isFinite(ratio) && ratio > 0 ? ratio : 1);
      const unitPrice = line.price.trim() ? Number(line.price) : policyPrice;
      if (!Number.isFinite(quantityValue) || quantityValue <= 0 || !Number.isFinite(unitPrice) || unitPrice < 0) return { ...summary, ready: false };
      const effectivePrice = (num(pricing, "effective") || num(pricing, "price") || num(sku, "price")) * (Number.isFinite(ratio) && ratio > 0 ? ratio : 1);
      const manualPrice = formType === "QUOTE" && !!line.price.trim() && (!Object.hasOwn(pricing, "priceAvailable") || !pricing.priceAvailable || Math.round(unitPrice * 10000) !== Math.round(policyPrice * 10000));
      const defaultDiscount = manualPrice ? 0 : quantityValue * Math.max(0, policyPrice - effectivePrice);
      const discountValue = line.discount.trim() ? Number(line.discount) : defaultDiscount;
      if (!Number.isFinite(discountValue) || discountValue < 0) return { ...summary, ready: false };
      const gross = Math.round(quantityValue * unitPrice);
      const net = Math.max(0, gross - Math.round(discountValue));
      const vat = Number(line.vat) || 0;
      const lineTotal = header.taxInclusive ? net : net + Math.round(net * vat / 100);
      return { goods: summary.goods + lineTotal, ready: summary.ready };
    }, { goods: 0, ready: true });
    const fee = Number(header.fee) || 0;
    const extra = quoteOnlyLines.reduce((sum, line) => sum + Math.round(Number(line.qty) * Number(line.price) || 0), 0);
    const extraReady = quoteOnlyLines.every(line => Number(line.qty) > 0 && Number(line.price) >= 0);
    return { goods: result.goods + extra, fee, total: result.goods + extra + fee, ready: result.ready && extraReady && (lines.length > 0 || quoteOnlyLines.length > 0) };
  }, [catalog, formType, header.fee, header.taxInclusive, lines, orderPrices.items, priceInfo, quoteOnlyLines, source]);
  const codOverGoods = formType === "QUOTE" && quotePreview.ready && (Number(header.cod) || 0) > quotePreview.goods;
  const documentStockLines = (d: Doc) => d.lines.map(l => ({ skuId: text(l, "sku_id"), qty: text(l, "qty"), unit: text(l, "unit"), baseQty: num(l, "base_qty") }));
  const shortages = stockShortages(catalog?.skus ?? [], stock, draft && formType === "POS" ? text(draft, "warehouse_id") : header.warehouseId, draft && formType === "POS" ? documentStockLines(draft) : lines);
  const checkStock = async (d?: Doc) => {
    const latest = await request<Row[]>("/api/v1/retail/stock"); setStock(latest);
    const wh = d ? text(d, "warehouse_id") : header.warehouseId;
    const missing = stockShortages(catalog?.skus ?? [], latest, wh, d ? documentStockLines(d) : lines);
    if (missing.length) throw new Error("Chưa đủ tồn tại " + text(catalog?.warehouses.find(w => text(w, "id") === wh) ?? {}, "name") + ": " + missing.map(s => `${s.name} cần ${quantity(s.requested)}, còn ${quantity(s.available)}, thiếu ${quantity(s.missing)} ${s.unit}`).join("; ") + ". Nhập hàng đã được duyệt hoặc chuyển giỏ sang đơn đặt trước.");
  };
  const recoverPreorder = async () => {
    if (!draft || draft.type !== "POS" || draft.status !== "DRAFT") return;
    const result = await command<Doc>(`/documents/${draft.id}/cancel`, { version: draft.version, reason: "Khách đặt trước do thiếu tồn; chuyển toàn bộ giỏ từ " + text(draft, "number") });
    if (result.status !== "CANCELLED") throw new Error("Chưa xác nhận hủy nháp. Kiểm tra phiếu trước khi chuyển giỏ.");
    setFormType("SALE_ORDER"); setSource(null); setDraft(null); setDetail(null); createPayload.current = null; setUncertainCreate(false); setPriceInfo({});
    setHeader(h => ({ ...h, paid: "0", reason: "", note: [h.note, "Đặt trước từ nháp đã hủy " + text(draft, "number")].filter(Boolean).join(" · ") }));
    toast.info("Đã hủy nháp POS và giữ toàn bộ giỏ để lập đơn đặt trước. Chọn khách hàng rồi lưu/xác nhận đơn; chưa xuất tồn hoặc thu tiền. Cọc được ghi riêng sau khi xác nhận đơn.");
    await load();
  };
  const checkForm = () => {
    if (!header.warehouseId) throw new Error("Chọn kho thực hiện trước khi lưu.");
    if (["QUOTE", "SALE_ORDER"].includes(formType) && !header.partnerId) throw new Error(formType === "QUOTE" ? "Báo giá cần chọn khách hàng." : "Đơn bán hàng cần chọn khách hàng.");
    if (formType === "QUOTE") {
      if (quoteEligibilityLoading) throw new Error("Đang tải khách hàng và Cơ hội; vui lòng đợi trước khi lưu.");
      if (!selectedQuoteOpportunity) throw new Error("Khách hàng chưa có Cơ hội đang được Sales chăm sóc.");
      if (!quoteWarehouses.some(warehouse => text(warehouse, "id") === header.warehouseId)) throw new Error("Chọn kho bán hàng thuộc chi nhánh của Cơ hội.");
      if (pendingQuoteCustomerIds.has(header.partnerId)) throw new Error("Khách hàng đã có báo giá đang chờ Quản lý duyệt; không thể tạo thêm báo giá.");
    }
    if (!lines.some(l => Number(l.qty) > 0)) throw new Error("Thêm ít nhất một dòng có số lượng lớn hơn 0.");
    if (lines.length > 200) throw new Error("Một phiếu tối đa 200 dòng hàng.");
    if (formType === "QUOTE" && !lines.some(line => Number(line.qty) > 0) && !quoteOnlyLines.some(line => line.name.trim() && Number(line.qty) > 0)) throw new Error("Thêm sản phẩm trong kho hoặc sản phẩm phát sinh.");
    if (["SALE_ORDER", "QUOTE"].includes(formType) && !source) {
      if (orderPrices.signature !== orderPriceSignature) throw new Error("Đang tải đơn giá; vui lòng đợi trước khi lưu.");
      if (orderPrices.error) throw new Error(orderPrices.error);
      for (const l of lines) {
        const price = orderPrices.items[l.key];
        if (!price || !Object.hasOwn(price, "priceAvailable")) throw new Error("Chưa xác định được giá bán; kiểm tra số lượng và đơn vị.");
        if (!price.priceAvailable && !l.price.trim()) throw new Error("Nhập đơn giá cho " + text(selected(l.skuId), "name") + " vì sản phẩm chưa có giá bán.");
        if (formType === "QUOTE" && l.price.trim()) {
          const sku = selected(l.skuId), ratio = l.unit === text(sku, "unit") ? 1 : Number(((sku.units ?? {}) as Row)[l.unit]);
          const manualPrice = !price.priceAvailable || Number(l.price) !== Math.round(num(price, "price") * ratio * 10000) / 10000;
          if (manualPrice && !l.priceReason?.trim()) throw new Error("Nhập lý do điều chỉnh đơn giá cho " + text(sku, "name") + " để Quản lý xem xét.");
        }
      }
    }
    if (![header.paid, header.fee, header.cod].every(v => /^\d+$/.test(v))) throw new Error("Tiền thu, phí giao và COD phải là số nguyên VND không âm.");
    for (const l of lines) {
      const qty = Number(l.qty);
      if (!Number.isFinite(qty) || qty < 0 || (!source && qty === 0) || !/^\d+(\.\d{1,4})?$/.test(l.qty)) throw new Error("Số lượng cần hợp lệ và có tối đa 4 chữ số thập phân.");
      if (qty > 0 && l.maxQty !== undefined && qty > l.maxQty) throw new Error("Lượng xuất vượt phần còn lại của đơn.");
      if ([l.price, l.discount, l.vat].some(v => v !== "" && (!Number.isFinite(Number(v)) || Number(v) < 0))) throw new Error("Giá, giảm và VAT không được âm.");
      if (Number(l.vat) > 100) throw new Error("VAT nằm trong khoảng 0–100%.");
    }
    if (codOverGoods) throw new Error("COD dự kiến không được lớn hơn tiền hàng tạm tính (" + money(quotePreview.goods) + ").");
  };
  const saveDraft = async (notify = true) => { if (!createPayload.current) { checkForm(); if (formType === "POS") await checkStock(); createPayload.current = { ...header, ...(formType === "QUOTE" && !header.address.trim() ? { address: (() => { const partner = catalog?.partners.find(p => text(p, "id") === header.partnerId) ?? {}; return text(partner, "shipping_address") || text(partner, "address"); })() } : {}), ...(formType === "SALE_ORDER" ? { fee: "0", cod: "0" } : {}), type: formType, quoteOnlyLines: formType === "QUOTE" ? quoteOnlyLines.filter(line => line.name.trim() && Number(line.qty) > 0).map(line => ({ name: line.name.trim(), unit: line.unit.trim() || "cái", qty: line.qty, price: line.price })) : undefined, opportunityId: formType==="QUOTE"?selectedQuoteOpportunity:undefined, sourceId: source?.id, partnerId: header.partnerId || undefined, lines: lines.filter(l => Number(l.qty) > 0).map(l => ({ skuId: l.skuId, sourceLineId: l.sourceLineId, qty: l.qty, unit: l.unit, price: formType === "SALE_ORDER" && !source && orderPrices.items[l.key]?.priceAvailable ? undefined : l.price || undefined, priceReason: formType === "QUOTE" ? l.priceReason?.trim() || undefined : undefined, discount: formType === "SALE_ORDER" ? undefined : l.discount || undefined, vat: l.vat || undefined, lot: l.lot, expiry: l.expiry || undefined, serials: l.serials.split("|").map(v => v.trim()).filter(Boolean), taxInclusive: header.taxInclusive })) }; } let d: Doc; try { d = await command<Doc>("/documents", createPayload.current); } catch (error) { const status = (error as { status?: number }).status; if (status && status >= 400 && status < 500) { createPayload.current = null; setUncertainCreate(false); } else { setUncertainCreate(true); } throw error; } createPayload.current = null; setUncertainCreate(false); setDraft(d); setDetail(d); if (!quoteComposerOnly) await load(); if (notify) toast.success(d.type === "SALE_ORDER" && d.status !== "DRAFT" ? "Đã tạo đơn hàng " + text(d, "number") + " · " + (statuses[d.status] ?? d.status) : "Đã lưu nháp " + text(d, "number") + ". Kiểm tra tổng tiền máy chủ trước khi xác nhận."); return d; };
  const submit = async (d: Doc) => {
    if (d.type === "POS") await checkStock(d);
    const result = d.type === "SALE_ORDER" && d.status !== "DRAFT" ? d : await command<Doc>(`/documents/${d.id}/submit`, { version: d.version, reason: header.reason.trim() || (d.type === "QUOTE" ? "Gửi báo giá để Quản lý xem xét" : "Xác nhận giao dịch bán hàng theo chính sách") });
    setDraft(result); setDetail(result); setDialog(""); setEditor(false);
    if (quoteComposerOnly) {
      toast.success("Đã gửi báo giá " + text(result, "number") + " cho Quản lý.");
      onQuoteComposerClose?.();
      return;
    }
    await load();
    toast.success(text(result, "number") + " · " + (statuses[result.status] ?? result.status));
    await openDetail(result.id);
  };
  const saved = draft;
  const sendQuoteToManager = async () => { if (formType !== "QUOTE") return; if (quotePending) throw new Error("Khách hàng đã có báo giá đang chờ Quản lý duyệt; không thể tạo thêm báo giá."); const quote = saved ?? await saveDraft(false); await submit(quote); };
  const debt = detail?.openItems?.reduce((sum, o) => sum + num(o, "remaining"), 0) ?? 0;
  const payments = finance.payments.filter(p => text(p, "document_id") === detail?.id || text(p, "sales_order_id") === detail?.id);
  const shipmentRows = deliveries.filter(d => text(d, "issue_id") === detail?.id || issues.some(issue => text(issue, "id") === text(d, "issue_id")));
  const downloadQuote = async (format: "xlsx" | "pdf" = "xlsx") => {
    if (!detail) return;
    const token = window.localStorage.getItem("core-access-token") || window.sessionStorage.getItem("core-access-token") || "";
    const response = await fetch(`${apiUrl}/api/v1/retail/documents/${detail.id}/quote-export?format=${format}`, { headers: { Authorization: "Bearer " + token } });
    if (!response.ok) { const problem = await response.json().catch(() => ({})); throw new Error(problem.detail || "Không thể xuất báo giá."); }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = `bao-gia-${text(detail, "number")}.${format}`; anchor.click(); URL.revokeObjectURL(url);
  };
  const actionInput = (name: string, label: string, type = "text") => <Field label={label}>{type === "number" ? <MoneyInput required={name === "amount"} value={actionForm[name] ?? ""} onChange={value => setActionForm(f => ({ ...f, [name]: value }))} /> : <input required={name === "reason"} type={type} value={actionForm[name] ?? ""} onChange={e => setActionForm(f => ({ ...f, [name]: e.target.value }))} />}</Field>;
  const openAction = (action: string, values: Record<string, string> = {}) => { setActionForm(values); setDialog(action); setError(""); };
  const action = async () => { if (!detail) return; if (["approve", "reject", "cancel"].includes(dialog)) { if (!actionForm.reason?.trim()) throw new Error("Nhập lý do thực hiện."); const result = await command<Doc>(`/documents/${detail.id}/${dialog}`, { version: detail.version, reason: actionForm.reason }); if (draft?.id === result.id) { setDraft(result); if (pos && result.status === "CANCELLED") setEditor(false); } setDetail(result); }
    if (dialog === "payment") { const amount = Number(actionForm.amount); if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("Số tiền cần là số nguyên VND lớn hơn 0."); const openItems = detail.openItems.filter(o => num(o, "remaining") > 0); if (detail.type !== "SALE_ORDER" && amount > debt) throw new Error("Tiền thu vượt công nợ còn mở. Khoản ứng trước ghi tại Thu chi."); await command("/payments", { branchId: detail.branch_id, partnerId: detail.partner_id || undefined, documentId: detail.id, kind: "RECEIPT", amount, method: actionForm.method || "CASH", reference: actionForm.reference || "Thu theo " + text(detail, "number"), allocations: detail.type === "SALE_ORDER" ? [] : openItems.length === 1 ? [{ openItemId: openItems[0].id, amount }] : [] }); }
    if (dialog === "delivery") await command("/deliveries", { issueId: detail.id, carrier: actionForm.carrier, tracking: actionForm.tracking, cod: actionForm.cod || "0", fee: actionForm.fee || "0", note: actionForm.note });
    if (dialog === "delivery-status") await command(`/deliveries/${actionForm.id}/status`, { version: Number(actionForm.version), status: actionForm.status, note: actionForm.note });
    if (dialog === "cod") await command(`/deliveries/${actionForm.id}/settle`, { version: Number(actionForm.version), amount: actionForm.amount, fee: actionForm.fee || "0", method: actionForm.method || "BANK" });
    const paymentRequested=dialog==="payment";setDialog(""); await load(); await openDetail(detail.id); toast.success(paymentRequested?"Đã gửi khoản thu sang Kế toán chờ phê duyệt.":"Đã ghi nhận thao tác."); };
  const shipmentNext = (value: string) => value === "PREPARING" ? ["SHIPPING", "FAILED"] : ["SHIPPING", "PARTIAL"].includes(value) ? (value === "PARTIAL" ? ["SHIPPING", "DELIVERED", "FAILED"] : ["PARTIAL", "DELIVERED", "FAILED"]) : [];
  const quoteOrderBlockedReason=!allowed("orders","CREATE")?"Bạn chưa có quyền tạo đơn bán."
    :detail?.status!=="APPROVED"?"Báo giá cần được duyệt trước khi tạo đơn."
    :text((detail?.metadata??{}) as Row,"customerResponse")==="DECLINE"?"Khách đã từ chối báo giá."
    :"";
  const chooseOrderQuote = () => {
    setSelectingOrderQuote(true); setKind("QUOTE"); setStatus("APPROVED");
    setQuery(""); setSearch(""); setPage(0); setDetail(null); setEditor(false); setError("");
  };
  const startOrderFromQuote = async (id: string) => {
    const quote = await request<Doc>("/api/v1/retail/documents/" + id);
    const meta = (quote.metadata ?? {}) as Row;
    if (quote.status !== "APPROVED" || text(meta,"pipelineType") === "EPC") throw new Error("Chọn báo giá bán hàng đã được duyệt.");
    const partner = (meta.partnerSnapshot ?? {}) as Row;
    setAcceptanceInput({channel:"PHONE",recipient:text(meta,"sentTo") || text(partner,"phone") || text(partner,"email") || text(partner,"name"),note:""});
    setAcceptanceShipping(initialShipping(quote));setAcceptanceQuote(quote);
  };
  const acceptQuoteAndContinue = async () => {
    if (!acceptanceQuote || !acceptanceShipping) return;
    const result = await fulfillQuote(request,acceptanceQuote.id,{...acceptanceInput,version:acceptanceQuote.version,shipping:acceptanceShipping});
    setAcceptanceQuote(null);setSelectingOrderQuote(false);setEditor(false);setKind("SALE_ORDER");
    await load();await openDetail(result.orderId);
    toast.success(`Đã tạo đơn ${result.orderNumber}, trừ tồn và tạo vận đơn GHN ${result.tracking}.`);
  };

  return <div className={`sales-workspace${pos ? " s-pos" : ""}${quoteComposerOnly ? " quote-composer-host" : ""}`}>
    {acceptanceQuote && <Dialog title="Chuyển báo giá thành đơn hàng" onClose={() => setAcceptanceQuote(null)} locked={busy}>
      <form onSubmit={event => { event.preventDefault(); void run(acceptQuoteAndContinue); }}>
        <div className="s-dialog-body">
          <p>Báo giá <strong>{text(acceptanceQuote,"number")}</strong>. Xác nhận theo trao đổi thực tế với khách; hệ thống lưu tài khoản Sales và thời gian xác nhận.</p>
          {error && <div className="s-alert s-error" role="alert">{error}</div>}
          {!text((acceptanceQuote.metadata ?? {}) as Row,"sentAt") && <>
            <Field label="Kênh đã trao đổi với khách"><select disabled={busy} value={acceptanceInput.channel} onChange={event => setAcceptanceInput(value => ({...value,channel:event.target.value}))}><option value="PHONE">Điện thoại / trực tiếp</option><option value="ZALO">Zalo</option><option value="EMAIL">Email</option><option value="OTHER">Khác</option></select></Field>
            <Field label="Khách đã trao đổi *"><input required maxLength={160} disabled={busy} value={acceptanceInput.recipient} onChange={event => setAcceptanceInput(value => ({...value,recipient:event.target.value}))} placeholder="Tên, số điện thoại hoặc email" /></Field>
          </>}
          {acceptanceShipping && <QuoteShippingFields quote={acceptanceQuote} request={request} value={acceptanceShipping} onChange={setAcceptanceShipping} disabled={busy}/>}
          <Field label="Ghi chú xác nhận"><textarea maxLength={1000} disabled={busy} value={acceptanceInput.note} onChange={event => setAcceptanceInput(value => ({...value,note:event.target.value}))} placeholder="Nội dung khách xác nhận đồng ý" /></Field>
        </div>
        <footer><button type="button" disabled={busy} onClick={() => setAcceptanceQuote(null)}>Đóng</button><button type="submit" className="s-primary" disabled={busy}>{busy ? "Đang ghi nhận…" : "Đồng ý — Xuất kho & tạo GHN"}</button></footer>
      </form>
    </Dialog>}
    {quoteComposerOnly && !catalog && <div className="s-backdrop"><div className="s-dialog" role="status" aria-live="polite"><p className="s-empty">{loading ? "Đang tải kho, sản phẩm và quyền lập báo giá…" : error || "Chưa tải được dữ liệu để lập báo giá."}</p>{!loading && <footer><CrmButton type="button" variant="outline" onClick={onQuoteComposerClose}>Đóng</CrmButton><CrmButton type="button" onClick={() => void load()}>Tải lại</CrmButton></footer>}</div></div>}
    <header className="s-heading"><div><p className="s-eyebrow">BÁN HÀNG</p><h1>{pos ? "Bán tại quầy" : kind === "QUOTE" ? "Báo giá" : "Đơn bán hàng"}</h1><p>{pos ? "Chọn hàng nhanh · Kiểm tra thanh toán · Xác nhận bán" : "Báo giá → Đơn bán → Xuất hàng → Giao hàng → Thu tiền"}</p></div><div className="s-actions">{(pos ? can("SELL") : true) && <button className="s-primary" disabled={busy || (!pos && !allowed("orders","CREATE")) || uncertainCreate || !!(editor && saved?.status === "DRAFT")} title={!pos && !allowed("orders","CREATE") ? "Bạn chưa có quyền tạo đơn bán." : undefined} onClick={() => pos ? start("POS") : chooseOrderQuote()}>{pos ? "+ Phiếu bán mới" : "Chuyển báo giá thành đơn hàng"}</button>}{pos && <button aria-pressed={showHistory} onClick={() => setShowHistory(v => !v)}>{showHistory ? "Ẩn lịch sử" : "Lịch sử phiếu"}</button>}<button disabled={loading || busy} onClick={() => void load()}>Làm mới</button></div></header>
    {!pos && <div className="s-scope">Danh sách theo toàn bộ chi nhánh/kho được cấp quyền. Kho trên phiếu xác định nơi thực hiện giao dịch.</div>}
    {selectingOrderQuote && <section className="s-panel" aria-label="Chọn báo giá để tạo đơn"><strong>Chọn báo giá để chuyển thành đơn hàng</strong><p>Chọn báo giá khách đã đồng ý trong danh sách bên dưới, rồi bấm Chuyển thành đơn hàng.</p><button type="button" disabled={busy} onClick={() => onNavigate("retail-quotes")}>Mở báo giá để ghi nhận phản hồi khách</button><button type="button" disabled={busy} onClick={() => { setSelectingOrderQuote(false); setKind("SALE_ORDER"); setStatus(""); setPage(0); }}>Quay lại danh sách đơn hàng</button></section>}
    {error && <div className="s-alert s-error" role="alert">{error}<ActionButton {...(quoteComposerOnly ? { size: "sm" as const } : {})} disabled={busy} onClick={() => void load()}>Tải lại danh sách</ActionButton></div>}
    {!catalog && <section className="s-panel s-empty panel-loading" aria-busy="true">{loading ? "Đang tải quyền, hàng hóa và chứng từ…" : "Chưa tải được dữ liệu."}<div style={{padding:"8px 14px 14px"}} aria-hidden="true">{Array.from({length:5}).map((_,i)=><div key={i} className="sk-row"/>)}</div></section>}
    {catalog && !catalog.warehouses.some(w => w.active) && <section className="s-panel s-empty">Chưa có kho hoạt động trong phạm vi của bạn.<button onClick={() => onNavigate("retail-setup")}>Mở thiết lập</button></section>}
    {catalog && editor && can("SELL") && pos && formType === "POS" && <PosEditor catalog={catalog} customers={customers} header={header} lines={lines} saved={saved} busy={busy} uncertain={uncertainCreate} request={request} available={available} shortages={shortages} recoverPreorder={() => void run(recoverPreorder)} updateHeader={updateHeader} updateLine={updateLine} addSku={addSku} removeLine={key => { setLines(ls => ls.filter(l => l.key !== key)); setPriceInfo({}); }} save={() => void run(saveDraft)} confirm={() => saved && void run(() => submit(saved))} cancel={() => { if (saved) { setDetail(saved); openAction("cancel"); } }} preorder={() => { setFormType("SALE_ORDER"); setHeader(h => ({ ...h, paid: "0", note: h.note || "Đặt trước từ giỏ tại quầy" })); setPriceInfo({}); toast.info("Giỏ được chuyển thành đơn đặt trước. Chọn khách hàng; đơn chưa xuất không giảm tồn. Cọc ghi sau khi xác nhận đơn."); }} />}
    {catalog && editor && can("SELL") && (!pos || formType !== "POS") && <Dialog quoteComposerOnly={quoteComposerOnly} title={formType === "QUOTE" ? "Lập báo giá sản phẩm" : "Lập " + types[formType].toLowerCase()} onClose={() => { setEditor(false); if (quoteComposerOnly) onQuoteComposerClose?.(); }} locked={busy} wide><section className="s-editor">{formType !== "QUOTE" && <header className="s-section-heading"><div><h2>{types[formType]}</h2><small>{source ? (quoteRevision ? "Bản mới giữ nguyên khách hàng; có thể chỉnh sửa sản phẩm, số lượng và giá." : "Nguồn: " + text(source, "number") + ". Giá và chính sách giữ theo nguồn.") : formType === "SALE_ORDER" ? "Đơn giá tự lấy theo chính sách. Hàng chưa có giá cần nhập tay." : "Đơn giá mặc định lấy từ sản phẩm; có thể điều chỉnh trước khi gửi quản lý."}</small></div><ActionButton {...(quoteComposerOnly ? { variant: "outline" as const, size: "sm" as const } : {})} disabled={busy} onClick={() => { setEditor(false); if (quoteComposerOnly) onQuoteComposerClose?.(); }}>Đóng</ActionButton></header>}
      {formType !== "SALE_ORDER" && !saved && <div className="s-tabs s-editor-tabs" role="tablist" aria-label="Khu vực nhập phiếu">
        <button role="tab" type="button" aria-selected={editorTab === "items"} onClick={() => setEditorTab("items")}>Hàng trên phiếu</button>
        <button role="tab" type="button" aria-selected={editorTab === "delivery"} onClick={() => setEditorTab("delivery")}>Giao hàng, thuế và ghi chú</button>
      </div>}
       <fieldset disabled={busy || !!saved || uncertainCreate} className="s-form-fields">{formType === "SALE_ORDER" ? <OrderEditor catalog={catalog} customers={customers} header={header} lines={lines} source={source} locked={busy || !!saved || uncertainCreate} prices={orderPrices.items} pricesReady={!!source || (orderPrices.signature === orderPriceSignature && !orderPrices.error)} available={available} addSku={addSku} updateHeader={updateHeader} updateLine={updateLine} removeLine={key => { setLines(ls => ls.filter(l => l.key !== key)); setPriceInfo({}); }} addCustomer={() => { if(!allowed("customer","CREATE"))return; setError(""); setCustomerForm({ code: "KH-" + crypto.randomUUID().slice(0, 8).toUpperCase(), name: "", entityType: "PERSON", phone: "", email: "", address: "", customer_group: "CUSTOMER_SALE" }); }} /> : <>{editorTab === "items" && <><div className={formType === "QUOTE" ? "s-form-grid s-quote-form" : "s-form-grid"}><div hidden={formType !== "QUOTE" && formWarehouses.length === 1}><Field label="Kho thực hiện *" hint={formType === "QUOTE" && quoteBranchId ? "Danh sách kho thuộc chi nhánh của cơ hội khách hàng đã chọn." : undefined} error={formType === "QUOTE" && !loading && !quoteEligibilityLoading && !formWarehouses.length ? "Không có kho bán hàng đang hoạt động phù hợp với chi nhánh của cơ hội. Vui lòng kiểm tra cấu hình kho." : undefined}><select value={header.warehouseId} onChange={e => updateHeader("warehouseId", e.target.value)}><option value="">{formType === "QUOTE" && !formWarehouses.length ? "Không có kho phù hợp" : "Chọn kho"}</option>{formWarehouses.map(w => <option key={text(w, "id")} value={text(w, "id")}>{text(w, "name")}</option>)}</select></Field></div><div className="s-customer-picker">{formType === "SALE_ORDER" && !source && <input aria-label="Tìm khách hàng" type="search" placeholder="Tìm tên, mã hoặc điện thoại khách…" value={customerSearch} onChange={e => setCustomerSearch(e.target.value)} />}<Field label={["QUOTE", "SALE_ORDER"].includes(formType) ? "Khách hàng *" : "Khách hàng"} hint={formType === "POS" ? "Có công nợ phải chọn khách. Trả đủ có thể bán cho khách vãng lai." : undefined}><select disabled={!!source} value={header.partnerId} onChange={e => updateHeader("partnerId", e.target.value)}>{formType === "QUOTE" ? <option value="" disabled>{quoteEligibilityLoading ? "Đang tải khách hàng đủ điều kiện…" : "Chọn khách hàng"}</option> : <option value="">Khách vãng lai</option>}{formType === "QUOTE" && !quoteEligibilityLoading && !quoteCustomers.length && <option value="" disabled>Chưa có khách hàng có Cơ hội đang chăm sóc</option>}{(formType === "QUOTE" ? quoteCustomers : customers).filter(c => text(c, "id") === header.partnerId || ["name", "code", "phone"].some(k => text(c, k).toLowerCase().includes(customerSearch.trim().toLowerCase()))).map(c => <option key={text(c, "id")} value={text(c, "id")} disabled={formType === "QUOTE" && pendingQuoteCustomerIds.has(text(c, "id"))}>{text(c, "name")} · {text(c, "phone")}{formType === "QUOTE" && pendingQuoteCustomerIds.has(text(c, "id")) ? " · Đang chờ duyệt" : ""}</option>)}</select></Field>{formType === "SALE_ORDER" && !source && <button type="button" onClick={() => { setError(""); setCustomerForm({ code: "KH-" + crypto.randomUUID().slice(0, 8).toUpperCase(), name: "", entityType: "PERSON", phone: "", email: "", address: "", customer_group: "CUSTOMER_SALE" }); }}>+ Thêm khách hàng</button>}</div>{formType !== "QUOTE" && <Field label="Kênh bán"><select disabled={!!source} value={header.channel} onChange={e => updateHeader("channel", e.target.value)}>{Object.entries(channels).filter(([value]) => value !== "SALES").map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>}{formType === "QUOTE" && <><Field label="Tiết kiệm" hint={<><span>Số tiền có thể tiết kiệm</span><span className="s-field-suggestion">Gợi ý: 1tr-1tr5/1 tháng</span></>}><input maxLength={160} value={header.monthlySaving} onChange={e => updateHeader("monthlySaving", e.target.value)} placeholder="1tr-1tr5/1 tháng" /></Field><Field label="Địa chỉ công trình" hint="Nhập địa chỉ lắp đặt, nếu không sẽ tự động lấy địa chỉ hồ sơ"><input maxLength={500} value={header.address} onChange={e => updateHeader("address", e.target.value)} placeholder="Nghĩa Dũng, Tân Kỳ, Nghệ An" /></Field><div className="s-field-span"><Field label="Hệ điện" hint="Dòng mô tả hệ thống ngay dưới Kính gửi"><input maxLength={500} value={header.systemDescription} onChange={e => updateHeader("systemDescription", e.target.value)} placeholder="Hệ điện năng lượng mặt trời 6,25kWp, sử dụng inverter 1 pha áp cao 2 trong 1 (HV) P100-6-H" /></Field></div></>}</div>
      <div className="s-selling-grid">{(!source || formType === "QUOTE") && <div className="s-picker">{formType === "QUOTE" && <div className="s-tabs s-picker-tabs" role="tablist" aria-label="Nguồn sản phẩm"><button role="tab" type="button" aria-selected={productTab === "stock"} onClick={() => setProductTab("stock")}>Sản phẩm tại kho</button><button role="tab" type="button" aria-selected={productTab === "custom"} onClick={() => setProductTab("custom")}>Sản phẩm phát sinh</button></div>}{(formType !== "QUOTE" || productTab === "stock") && (quoteProductsLoading ? <p className="s-empty" role="status">Đang tải sản phẩm…</p> : <><form onSubmit={e => { e.preventDefault(); const matches = catalog.skus.filter(s => s.active && available(text(s, "id")) > 0 && [text(s, "barcode"), text(s, "code")].some(v => v && v.toLowerCase() === productSearch.trim().toLowerCase())); if (matches.length === 1) { addSku(matches[0]); setProductSearch(""); } }}><Field label="Tìm tên, mã SKU hoặc quét barcode"><input type="search" value={productSearch} onChange={e => setProductSearch(e.target.value)} placeholder="Quét barcode rồi nhấn Enter" /></Field></form><div className="s-product-toolbar"><small className="s-muted">{matchingProducts.length} sản phẩm còn tồn</small><label>Hiển thị <select value={productPageSize} onChange={e => setProductPageSize(Number(e.target.value))}><option value={5}>5</option><option value={10}>10</option><option value={25}>25</option><option value={50}>50</option><option value={100}>100</option></select> sản phẩm</label></div><ul className="s-product-results" aria-label="Kết quả tìm sản phẩm">{visibleProducts.map((sku, index) => <li key={text(sku, "id")}><span className="s-product-index">{productPage * productPageSize + index + 1}</span><button type="button" className="s-product-result" onClick={() => addSku(sku)}><span><strong>{text(sku, "name")}</strong><small>{text(sku, "code")} · {text(sku, "variant") || text(sku, "unit")}</small></span><span><b>{num(sku, "price") > 0 ? money(sku.price) : "Chưa có giá"}</b><small>{formType === "QUOTE" && available(text(sku, "id")) <= 0 ? "Không có trong kho · Mục II" : `Tồn: ${quantity(available(text(sku, "id")))} ${text(sku, "unit")}`}</small></span></button></li>)}</ul>{matchingProducts.length === 0 && <p className="s-empty">Không có sản phẩm còn tồn phù hợp tại kho này.</p>}<nav className="s-paging" aria-label="Phân trang sản phẩm"><ActionButton {...(quoteComposerOnly ? { variant: "outline" as const, size: "sm" as const } : {})} type="button" disabled={productPage === 0} onClick={() => setProductPage(current => current - 1)}>{quoteComposerOnly && <ChevronLeft aria-hidden="true" />}Trước</ActionButton><span>Trang {productPage + 1} / {productTotalPages}</span><ActionButton {...(quoteComposerOnly ? { variant: "outline" as const, size: "sm" as const } : {})} type="button" disabled={productPage + 1 >= productTotalPages} onClick={() => setProductPage(current => current + 1)}>Sau{quoteComposerOnly && <ChevronRight aria-hidden="true" />}</ActionButton></nav><small className="s-muted">Chỉ hiển thị hàng có tồn khả dụng lớn hơn 0 tại kho này.</small></>)}{formType === "QUOTE" && productTab === "custom" && <form className="s-quote-only" onSubmit={event => { event.preventDefault(); const name = quoteOnlyDraft.name.trim(); const qty = Number(quoteOnlyDraft.qty); const price = Number(quoteOnlyDraft.price); if (!name || !Number.isFinite(qty) || qty <= 0 || !Number.isFinite(price) || price < 0) { setError("Nhập tên, số lượng và đơn giá cho sản phẩm phát sinh."); return; } setQuoteOnlyLines(items => [...items, { key: crypto.randomUUID(), name, unit: quoteOnlyDraft.unit.trim() || "cái", qty: quoteOnlyDraft.qty, price: quoteOnlyDraft.price }]); setQuoteOnlyDraft({ name: "", unit: "cái", qty: "1", price: "" }); setError(""); }}><div className="s-form-grid"><Field label="Sản phẩm phát sinh"><input maxLength={160} value={quoteOnlyDraft.name} onChange={event => setQuoteOnlyDraft(draft => ({ ...draft, name: event.target.value }))} placeholder="Tên sản phẩm" /></Field><Field label="Đơn vị"><input maxLength={40} value={quoteOnlyDraft.unit} onChange={event => setQuoteOnlyDraft(draft => ({ ...draft, unit: event.target.value }))} /></Field><Field label="Số lượng"><input type="number" min="0.0001" step="0.0001" value={quoteOnlyDraft.qty} onChange={event => setQuoteOnlyDraft(draft => ({ ...draft, qty: event.target.value }))} /></Field><Field label="Đơn giá"><MoneyInput value={quoteOnlyDraft.price} onChange={value => setQuoteOnlyDraft(draft => ({ ...draft, price: value }))} /></Field></div><ActionButton {...(quoteComposerOnly ? { variant: "outline" as const, size: "sm" as const } : {})} type="submit">Thêm vào phiếu</ActionButton></form>}</div>}
      <div className="s-cart">
        <h3>Hàng trên phiếu <span>{cartQuery ? `${cartEntries.length}/${lines.length} sản phẩm` : `${lines.length} sản phẩm`}</span></h3>
        {lines.length > 0 && <div className="s-cart-search"><input type="search" aria-label="Tìm hàng trên phiếu" placeholder="Tìm theo tên, mã SKU, barcode hoặc ĐVT…" value={cartSearch} onChange={e => setCartSearch(e.target.value)} />{cartSearch && <ActionButton {...(quoteComposerOnly ? { variant: "outline" as const, size: "sm" as const } : {})} type="button" onClick={() => setCartSearch("")}>{quoteComposerOnly && <X aria-hidden="true" />}Xóa lọc</ActionButton>}</div>}
        {quoteOnlyLines.length > 0 && <ul className="s-quote-only-lines">{quoteOnlyLines.map(item => <li key={item.key}><span><strong>{item.name}</strong><small>Sản phẩm phát sinh · {item.qty} {item.unit} · {money(item.price)}</small></span><ActionButton {...(quoteComposerOnly ? { variant: "ghost" as const, size: "icon-sm" as const } : {})} type="button" onClick={() => setQuoteOnlyLines(items => items.filter(line => line.key !== item.key))} aria-label={"Bỏ " + item.name}>{quoteComposerOnly ? <X aria-hidden="true" /> : "×"}</ActionButton></li>)}</ul>}
        {lines.length === 0 && quoteOnlyLines.length === 0 && <p className="s-empty">Chọn sản phẩm để thêm vào phiếu.</p>}
        {lines.length > 0 && !cartEntries.length && <p className="s-empty">Không có dòng nào khớp “{cartSearch}”.</p>}
        {cartEntries.map(({ line: l, index }) => {
          const sku = selected(l.skuId);
          const snapshot = source?.lines.find(sl => text(sl, "id") === l.sourceLineId)?.sku_snapshot as Row | undefined;
          const product = snapshot ?? sku;
          const unitOptions = [text(sku, "unit"), ...Object.keys((sku.units ?? {}) as Row)];
          const isQuote = formType === "QUOTE";
          const expanded = !!expandedQuoteLines[l.key];
          const form = <>
            <div className="s-line-heading">
              <div>{!isQuote && <strong>{index + 1}. {text(product, "name")}</strong>}<small>{text(product, "code")} · {text(product, "variant")}</small></div>
              {!isQuote && <button type="button" onClick={() => { setLines(ls => ls.filter(v => v.key !== l.key)); setPriceInfo({}); }} aria-label={"Bỏ " + text(product, "name")}>×</button>}
            </div>
            <div className="s-line-grid">
              <Field label="Số lượng"><input type="number" min={source ? 0 : 0.0001} max={l.maxQty} step="0.0001" value={l.qty} onChange={e => updateLine(l.key, "qty", e.target.value)} /></Field>
              <Field label="Đơn vị"><select disabled={!!source} value={l.unit} onChange={e => updateLine(l.key, "unit", e.target.value)}>{[...new Set([l.unit, ...unitOptions])].filter(Boolean).map(unit => <option key={unit}>{unit}</option>)}</select></Field>
              <Field label="Đơn giá" hint={source && !quoteRevision ? "Theo phiếu nguồn" : formType === "SALE_ORDER" ? orderPrices.signature !== orderPriceSignature ? "Đang tra giá…" : orderPrices.error ? "Chưa tải được giá" : orderPrices.items[l.key]?.priceAvailable ? "Giá theo chính sách · tự cập nhật" : "Chưa có giá · nhập đơn giá" : "Trống: theo bảng giá"}><MoneyInput disabled={(!!source && !quoteRevision) || (formType === "SALE_ORDER" && (orderPrices.signature !== orderPriceSignature || !!orderPrices.error || !!orderPrices.items[l.key]?.priceAvailable))} value={formType === "SALE_ORDER" && !source && orderPrices.signature === orderPriceSignature && orderPrices.items[l.key]?.priceAvailable ? String(Math.round(Number(orderPrices.items[l.key].price) * (l.unit === text(sku, "unit") ? 1 : Number(((sku.units ?? {}) as Row)[l.unit])) * 10000) / 10000) : l.price} placeholder="Nhập đơn giá" onChange={value => updateLine(l.key, "price", value)} /></Field>
              {isQuote && <Field label="Lý do điều chỉnh giá" hint="Bắt buộc khi nhập giá khác bảng giá hoặc sản phẩm chưa có giá."><input value={l.priceReason ?? ""} onChange={e => updateLine(l.key, "priceReason", e.target.value)} /></Field>}
              {formType !== "SALE_ORDER" && <Field label="Giảm dòng (₫)" hint="Số tiền giảm trực tiếp cho dòng này, tính trước VAT."><MoneyInput disabled={!!source && !quoteRevision} value={l.discount} onChange={value => updateLine(l.key, "discount", value)} /></Field>}
              <Field label="VAT (%)"><input disabled={!!source && !quoteRevision} type="number" min="0" max="100" step="0.0001" value={l.vat} onChange={e => updateLine(l.key, "vat", e.target.value)} /></Field>
            </div>
            {l.maxQty !== undefined && <small>Còn được xuất: {quantity(l.maxQty)} {l.unit}. Nhập 0 hoặc bỏ dòng để xuất lần sau.</small>}
            {text(product, "tracking") === "LOT" && <div className="s-form-grid"><Field label="Lô xuất" hint="Trống để ưu tiên hạn sớm (FEFO)"><input value={l.lot} onChange={e => updateLine(l.key, "lot", e.target.value)} /></Field><Field label="Hạn sử dụng"><input type="date" value={l.expiry} onChange={e => updateLine(l.key, "expiry", e.target.value)} /></Field></div>}
            {text(product, "tracking") === "SERIAL" && <Field label="Serial *" hint="Mỗi đơn vị cơ sở có một serial, ngăn bằng dấu |"><input value={l.serials} placeholder="SN001|SN002" onChange={e => updateLine(l.key, "serials", e.target.value)} /></Field>}
            {priceInfo[l.key] && <small className="s-price-info">Giá cơ sở theo chính sách: {money(priceInfo[l.key].effective)} / {text(sku, "unit")} · {Array.isArray(priceInfo[l.key].promotions) ? (priceInfo[l.key].promotions as unknown[]).length : 0} ưu đãi. Tổng và thuế xác nhận trên nháp.</small>}
          </>;
          return <article className={isQuote ? "s-line s-quote-line" : "s-line"} key={l.key}>
            {isQuote ? <>
              <div className="s-quote-line-summary">
                <strong className="s-quote-line-name" title={text(product, "name")}>{index + 1}. {text(product, "name")}</strong>
                <div className="s-quote-line-value"><small>Số lượng</small><strong>{l.qty.trim() ? quantity(l.qty) : "—"}</strong></div>
                <div className="s-quote-line-value"><small>Đơn giá</small><strong>{l.price.trim() ? money(l.price) : "Theo bảng giá"}</strong></div>
                <div className="s-quote-line-actions">
                  <ActionButton {...(quoteComposerOnly ? { variant: "ghost" as const, size: "icon-sm" as const } : {})} type="button" className="s-quote-line-toggle" aria-label={(expanded ? "Thu gọn " : "Mở chi tiết ") + text(product, "name")} aria-expanded={expanded} aria-controls={`quote-line-${l.key}`} onClick={() => setExpandedQuoteLines(current => ({ ...current, [l.key]: !current[l.key] }))}>
                    {quoteComposerOnly ? <ChevronDown aria-hidden="true" /> : <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>}
                  </ActionButton>
                  <ActionButton {...(quoteComposerOnly ? { variant: "ghost" as const, size: "icon-sm" as const } : {})} type="button" className="s-quote-line-remove" onClick={() => { setLines(ls => ls.filter(v => v.key !== l.key)); setPriceInfo({}); }} aria-label={"Bỏ " + text(product, "name")}>{quoteComposerOnly ? <X aria-hidden="true" /> : "×"}</ActionButton>
                </div>
              </div>
              <div id={`quote-line-${l.key}`} className="s-quote-line-details" data-expanded={expanded} aria-hidden={!expanded} inert={!expanded}>
                <div className="s-quote-line-clip"><div className="s-quote-line-form">{form}</div></div>
              </div>
            </> : form}
          </article>;
        })}
      </div></div></>}
       {editorTab === "delivery" && <div className="s-tab-panel" role="tabpanel" aria-label="Giao hàng, thuế và ghi chú"><div className="s-form-grid">{formType === "SALE_ORDER" && <Field label="Địa chỉ giao"><input value={header.address} onChange={e => updateHeader("address", e.target.value)} /></Field>}{formType === "QUOTE" && <Field label="COD dự kiến (₫)" hint={`Không được lớn hơn tiền hàng tạm tính ${money(quotePreview.goods)}`} error={codOverGoods ? `Đang vượt tiền hàng tạm tính ${money(quotePreview.goods)}.` : undefined}><MoneyInput value={header.cod} onChange={value => updateHeader("cod", value)} /></Field>}{formType === "QUOTE" && <Field label="Hiệu lực báo giá"><input type="date" min={vietnamDate()} value={header.validUntil} onChange={e => updateHeader("validUntil", e.target.value)} /></Field>}{!["ISSUE", "SALE_ORDER"].includes(formType) && <Field label="Phí vận chuyển (₫)"><MoneyInput value={header.fee} onChange={value => updateHeader("fee", value)} /></Field>}<Field label="Ghi chú"><textarea value={header.note} onChange={e => updateHeader("note", e.target.value)} /></Field></div>{!source && <label className="s-checkbox"><input type="checkbox" checked={header.taxInclusive} onChange={e => updateHeader("taxInclusive", e.target.checked)} /> Đơn giá đã bao gồm VAT</label>}{formType === "QUOTE" && <div className="s-quote-total-preview" aria-live="polite"><div><span>Tiền hàng tạm tính</span><strong>{money(quotePreview.goods)}</strong></div><div><span>Phí vận chuyển</span><strong>{money(quotePreview.fee)}</strong></div><div className="s-quote-total-preview-grand"><span>Tổng báo giá tạm tính</span><strong>{money(quotePreview.total)}</strong></div>{!quotePreview.ready && <small>Vui lòng nhập đủ số lượng và đơn giá để xem tổng chính xác.</small>}</div>}</div>}
      {editorTab === "items" && formType === "POS" && <div className="s-checkout"><Field label="Thu ngay (₫)" hint="Không ghi tiền khách đưa vượt tổng. Còn nợ phải chọn khách."><MoneyInput value={header.paid} onChange={value => updateHeader("paid", value)} /></Field><Field label="Phương thức"><select value={header.method} onChange={e => updateHeader("method", e.target.value)}>{Object.entries(methods).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></Field></div>}
      </>}</fieldset>
      {["SALE_ORDER", "QUOTE"].includes(formType) && !source && orderPrices.signature === orderPriceSignature && orderPrices.error && <div className="s-alert s-error" role="alert">{orderPrices.error}<ActionButton {...(quoteComposerOnly ? { size: "sm" as const } : {})} disabled={busy} onClick={() => void load()}>Tra giá lại</ActionButton></div>}
      {!saved && <footer className="s-editor-footer">{formType === "QUOTE" && error && <div className="s-alert s-error" role="alert" style={{ flexBasis: "100%" }}>{error}</div>}<span>{uncertainCreate ? "Chưa rõ kết quả lần gửi trước. Biểu mẫu được giữ nguyên; thử lại để tra kết quả, không tạo phiếu mới." : formType === "QUOTE" ? "Báo giá sẽ được kiểm tra tổng tiền và gửi trực tiếp cho Quản lý duyệt." : formType === "SALE_ORDER" && source ? "Đơn được tạo ở trạng thái đã xác nhận theo báo giá khách đã đồng ý. Chưa xuất kho hoặc ghi tiền." : "Nháp chưa trừ tồn hoặc ghi tiền. Kiểm tra số tiền máy chủ trước bước xác nhận."}</span><div className="s-actions">{!source && formType !== "SALE_ORDER" && formType !== "QUOTE" && <button disabled={busy || uncertainCreate || !lines.length} onClick={() => void run(async () => { checkForm(); const prices = await Promise.all(lines.map(async l => { const sku = selected(l.skuId); const factor = l.unit === text(sku, "unit") ? 1 : Number(((sku.units ?? {}) as Row)[l.unit]); return [l.key, await request<Row>("/api/v1/retail/price", { method: "POST", body: JSON.stringify({ skuId: l.skuId, warehouseId: header.warehouseId, partnerId: header.partnerId || undefined, channel: header.channel, qty: Number(l.qty) * factor }) })] as const; })); setPriceInfo(Object.fromEntries(prices)); })}>Tra giá theo chính sách</button>}{pos && !source && <button disabled={busy || uncertainCreate || !lines.length} onClick={() => { setFormType("SALE_ORDER"); setHeader(h => ({ ...h, paid: "0", note: h.note || "Đặt trước từ giỏ tại quầy" })); setPriceInfo({}); toast.info("Giỏ được chuyển thành đơn đặt trước. Chọn khách hàng; đơn chưa xuất không giảm tồn. Cọc ghi sau khi xác nhận đơn."); }}>Lập đơn đặt trước từ giỏ</button>}{formType === "QUOTE" ? <ActionButton className={quoteComposerOnly ? undefined : "s-primary"} disabled={busy || (!lines.length && !quoteOnlyLines.length) || !header.warehouseId} onClick={() => void run(sendQuoteToManager)}>{busy ? "Đang gửi…" : uncertainCreate ? "Thử lại gửi Quản lý" : "Gửi Quản lý"}</ActionButton> : <button className="s-primary" disabled={busy || !lines.length || !header.warehouseId || (formType === "SALE_ORDER" && !source && !uncertainCreate && (orderPrices.signature !== orderPriceSignature || !!orderPrices.error))} onClick={() => void run(saveDraft)}>{busy ? "Đang xử lý…" : uncertainCreate ? "Thử lại cùng lần lưu" : formType === "SALE_ORDER" && source ? "Tạo đơn hàng" : "Lưu nháp & kiểm tra tiền"}</button>}</div></footer>}
      {saved && <div className="s-review"><div>{formType === "QUOTE" && error && <div className="s-alert s-error" role="alert">{error}</div>}<Badge value={saved.status} /><h3>{text(saved, "number")}</h3><strong className="s-grand-total">{money(saved.total)}</strong><p>Tổng do máy chủ tính, gồm giảm giá, VAT và phí áp dụng.</p>{saved.type === "POS" && <p>Thu ngay: {money(saved.paid)} · Còn phải thu khi ghi: {money(num(saved, "total") - num(saved, "paid"))}</p>}</div><div className="s-actions">{saved.status === "DRAFT" && <><Field label="Nội dung xác nhận / lý do ngoại lệ"><input value={header.reason} onChange={e => setHeader(h => ({ ...h, reason: e.target.value }))} /></Field><ActionButton type="button" className={quoteComposerOnly ? undefined : "s-primary"} disabled={busy} onClick={() => void run(() => submit(saved))}>{saved.type === "QUOTE" ? busy ? "Đang gửi…" : "Gửi Quản lý" : "Xác nhận " + (saved.type === "POS" ? "bán hàng" : types[saved.type].toLowerCase())}</ActionButton><ActionButton {...(quoteComposerOnly ? { variant: "outline" as const } : {})} disabled={busy} onClick={() => { setDetail(saved); openAction("cancel"); }}>Hủy nháp để lập lại</ActionButton></>}<small>Nháp đã lưu hiện chưa hỗ trợ sửa nội dung. Có thể giữ nháp hoặc hủy và lập lại; không tạo phiếu mới khi chưa rõ kết quả lần trước.</small></div></div>}
    </section></Dialog>}
    {catalog && (!pos || showHistory || !can("SELL")) && <section className="s-panel"><header className="s-section-heading"><div><h2>{pos ? "Phiếu bán tại quầy" : "Danh sách chứng từ bán hàng"}</h2><small>{list.total} chứng từ phù hợp · 50 dòng/trang</small></div>{!pos && can("SELL") && <button disabled={busy || (uncertainCreate || !!(editor && saved?.status === "DRAFT"))} onClick={() => start("QUOTE")}>+ Tạo báo giá</button>}</header>{!pos && <div className="s-tabs" role="tablist" aria-label="Loại chứng từ">{saleTypes.map(type => <button role="tab" aria-selected={kind === type} key={type} onClick={() => { setKind(type); setPage(0); }}>{types[type]}</button>)}</div>}<form className="s-filters" onSubmit={e => { e.preventDefault(); setSearch(query); setPage(0); }}><input aria-label="Tìm số phiếu hoặc khách hàng" placeholder="Tìm số phiếu hoặc tên khách…" type="search" value={query} onChange={e => setQuery(e.target.value)} /><select aria-label="Lọc trạng thái" value={status} onChange={e => { setStatus(e.target.value); setPage(0); }}><option value="">Tất cả trạng thái</option>{["DRAFT", "PENDING", "APPROVED", "POSTED", "PARTIAL", "COMPLETE", "CLOSED", "REJECTED", "CANCELLED"].map(v => <option key={v} value={v}>{statuses[v]}</option>)}</select><button disabled={loading}>Tìm kiếm</button></form>{loading ? <div className={"s-table-loading"+(list.items.length?" panel-loading":"")} role="status" style={{minHeight:"var(--table-min-h)"}}>{!list.items.length&&<div style={{padding:"14px"}}>{Array.from({length:6}).map((_,i)=><div key={i} className="sk-row"/>)}</div>}</div> : <><Table headings={["STT", "Số phiếu / Ngày", "Khách hàng", "Kho / Kênh", "Giá trị", "Trạng thái", "Nợ trên phiếu", "Thao tác"]}>{list.items.map((d, i) => <tr key={text(d, "id")}><td>{page * 50 + i + 1}</td><td><strong>{text(d, "number")}</strong><small>{timestamp(d.created_at)}</small></td><td>{text(d, "partner") || "Khách vãng lai"}</td><td>{text(d, "warehouse")}<small>{channels[text(d, "channel")]}</small></td><td>{money(d.total)}</td><td><Badge value={d.status} /></td><td>{["SALE_ORDER", "QUOTE"].includes(text(d, "type")) ? "Theo phiếu xuất" : money(d.debt)}</td><td>{text(d,"type") === "QUOTE" && text((d.metadata??{}) as Row,"pipelineType")!=="EPC" && <button type="button" disabled={busy || !allowed("orders","CREATE") || uncertainCreate || !!(editor && saved?.status === "DRAFT")} onClick={() => void run(() => startOrderFromQuote(text(d,"id")))}>Chuyển thành đơn hàng</button>}<button disabled={busy} onClick={() => void run(() => openDetail(text(d, "id")))}>Chi tiết</button></td></tr>)}</Table>{!list.items.length && <div className="s-empty">Chưa có chứng từ phù hợp. Thay bộ lọc hoặc tạo phiếu mới.</div>}<nav className="s-paging" aria-label="Phân trang chứng từ"><button disabled={!page || busy} onClick={() => setPage(p => p - 1)}>Trước</button><span>Trang {page + 1} / {Math.max(1, Math.ceil(list.total / 50))}</span><button disabled={(page + 1) * 50 >= list.total || busy} onClick={() => setPage(p => p + 1)}>Sau</button></nav></> }</section>}
     {detail && catalog && !(pos && editor && formType === "POS" && saved?.id === detail.id) && <section className="s-panel s-detail" aria-label="Chi tiết chứng từ"><header className="s-section-heading"><div><p className="s-eyebrow">{types[detail.type] ?? detail.type}</p><h2>{text(detail, "number")}</h2><Badge value={detail.status} /></div><div className="s-actions"><button disabled={!allowed(featureFor(detail.type),"PRINT")} onClick={() => void run(async()=>{await request("/api/v1/retail/documents/"+detail.id+"/print");window.print();})}>In phiếu</button>{detail.type === "QUOTE" && detail.status === "APPROVED" && allowed("orders", "EXPORT") && <><button disabled={busy} onClick={() => void run(() => downloadQuote("xlsx"))}>Xuất Excel</button><button disabled={busy} onClick={() => void run(() => downloadQuote("pdf"))}>Xuất PDF</button></>}<button onClick={() => setDetail(null)}>Đóng chi tiết</button></div></header><div className="s-detail-info"><span>Khách: <strong>{text(((detail.metadata as Row)?.partnerSnapshot ?? catalog.partners.find(p => text(p, "id") === text(detail, "partner_id")) ?? {}) as Row, "name") || "Khách vãng lai"}</strong></span><span>Kho: {text(catalog.warehouses.find(w => text(w, "id") === text(detail, "warehouse_id")) ?? {}, "name")}</span><span>Lập: {timestamp(detail.created_at)}</span><span>Ghi: {timestamp(detail.posted_at)}</span>{detail.source_id || detail.sales_order_id ? <button onClick={() => void run(() => openDetail(text(detail, detail.source_id ? "source_id" : "sales_order_id")))}>Mở phiếu nguồn</button> : null}</div><Table headings={["STT", "SKU / Biến thể", "ĐVT", "Lượng", "Đã xuất / Còn lại", "Đơn giá", "Giảm", "Thuế", "Thành tiền"]}>{detail.lines.map((l, i) => { const snap = (l.sku_snapshot ?? {}) as Row; return <tr key={text(l, "id")}><td>{i + 1}</td><td><strong>{text(snap, "name")}</strong><small>{text(snap, "code")} · {text(snap, "variant")}</small>{text(l, "lot") && <small>Lô {text(l, "lot")} · Hạn {text(l, "expiry")}</small>}{Array.isArray(l.segments) && l.segments.map((segment, idx) => <small key={idx}>Lô {text(segment as Row, "lot")}: {quantity((segment as Row).qty)} · {text(segment as Row, "expiry")}</small>)}{Array.isArray(l.serials) && l.serials.length > 0 && <small>Serial: {l.serials.join(" | ")}</small>}</td><td>{text(l, "unit")}</td><td>{quantity(l.qty)}</td><td>{detail.type === "SALE_ORDER" ? `${quantity(num(l, "progress") / num(l, "ratio"))} / ${quantity(Math.max(0, num(l, "base_qty") - num(l, "progress") - num(l, "closed_qty")) / num(l, "ratio"))}` : "—"}</td><td>{money(l.price)}</td><td>{money(l.discount)}</td><td>{money(l.tax)}</td><td>{money(l.total)}</td></tr>; })}</Table><div className="s-detail-totals"><span>Tiền hàng: {money(num(detail,"total")-num(detail,"fee"))}</span><span>Phí vận chuyển: {money(detail.fee)}</span><strong>Tổng: {money(detail.total)}</strong>{["POS", "ISSUE"].includes(detail.type) && <span>Nợ còn mở hiện tại: {money(debt)} · Đã phân bổ: {money(detail.openItems.reduce((sum, o) => sum + num(o, "allocated"), 0))} · Giảm do trả: {money(detail.openItems.reduce((sum, o) => sum + num(o, "credit"), 0))}</span>}</div><div className="s-detail-info"><p>{text(detail, "note")}</p><p>{text(detail, "reason")}</p>{text((detail.metadata ?? {}) as Row, "address") && <p>Giao tới: {text(detail.metadata as Row, "address")}</p>}</div><div className="s-actions s-detail-actions">
      {allowed(featureFor(detail.type),"SUBMIT") && detail.status === "DRAFT" && <><button className="s-primary" disabled={busy} onClick={() => void run(() => submit(detail))}>Xác nhận / Gửi duyệt</button><button disabled={busy} onClick={() => openAction("cancel")}>Hủy bản nháp</button></>}
      {allowed(featureFor(detail.type),"APPROVE") && detail.status === "PENDING" && <><button disabled={busy || (text(detail, "creator_id") === catalog.accountId && !catalog.canSelfApprove)} onClick={() => openAction("approve")}>Duyệt</button><button disabled={busy || (text(detail, "creator_id") === catalog.accountId && !catalog.canSelfApprove)} onClick={() => openAction("reject")}>Từ chối</button>{(text(detail, "creator_id") === catalog.accountId && !catalog.canSelfApprove) && <small>Chờ người khác duyệt phiếu bạn đã lập.</small>}</>}
      {detail.type === "QUOTE" && <><button disabled={busy || !!quoteOrderBlockedReason || uncertainCreate || !!(editor && saved?.status === "DRAFT")} aria-describedby={quoteOrderBlockedReason?"sales-quote-order-blocked":undefined} onClick={() => void run(() => startOrderFromQuote(detail.id))}>Tạo đơn từ báo giá</button>{quoteOrderBlockedReason&&<span id="sales-quote-order-blocked" className="s-muted">{quoteOrderBlockedReason}</span>}</>}
      {allowed("issue","CREATE") && detail.type === "SALE_ORDER" && ["APPROVED", "PARTIAL"].includes(detail.status) && <button disabled={(uncertainCreate || !!(editor && saved?.status === "DRAFT"))} onClick={() => start("ISSUE", detail)}>Xuất phần còn lại</button>}
      {can("FINANCE") && ((detail.type === "SALE_ORDER" && ["APPROVED", "PARTIAL"].includes(detail.status)) || (["POS", "ISSUE"].includes(detail.type) && detail.status === "POSTED" && debt > 0)) && <button onClick={() => openAction("payment", { amount: detail.type === "SALE_ORDER" ? "" : String(debt), method: "CASH" })}>{detail.type === "SALE_ORDER" ? "Ghi nhận cọc" : "Thu công nợ"}</button>}
      {allowed("delivery", "CREATE") && ["POS", "ISSUE"].includes(detail.type) && detail.status === "POSTED" && <button onClick={() => openAction("delivery", { cod: String(debt), fee: "0" })}>Tạo đợt giao</button>}
      {can("SELL") && ["POS", "ISSUE"].includes(detail.type) && detail.status === "POSTED" && <button onClick={() => onNavigate("retail-returns")}>Đổi trả / Bảo hành</button>}
      {can("SELL") && detail.type === "SALE_ORDER" && ["APPROVED", "PARTIAL"].includes(detail.status) && <button disabled title="Luồng duyệt yêu cầu hủy chưa có backend">Yêu cầu hủy phần chưa xuất</button>}
      {["SALE_ORDER","ISSUE"].includes(detail.type)&&allowed("delivery","VIEW")&&<button onClick={()=>onNavigate("retail-shipping")}>Giao hàng GHN / Tracking</button>}
      <button onClick={() => onNavigate("retail-cashflow")}>Mở Thu chi</button></div>
      {detail.type === "SALE_ORDER" && <section className="s-related"><h3>Phiếu xuất của đơn</h3><Table headings={["STT", "Phiếu xuất", "Kho", "Giá trị", "Trạng thái", "Nợ còn mở", "Thao tác"]}>{issues.map((issue, index) => <tr key={text(issue, "id")}><td>{index + 1}</td><td>{text(issue, "number")}</td><td>{text(issue, "warehouse")}</td><td>{money(issue.total)}</td><td><Badge value={issue.status}/></td><td>{money(issue.debt)}</td><td><button disabled={busy} onClick={() => void run(() => openDetail(text(issue, "id")))}>Mở phiếu xuất</button></td></tr>)}</Table>{!issues.length && <p className="s-empty">Chưa có phiếu xuất thuộc đơn trong phạm vi được cấp.</p>}</section>}{can("FINANCE") && <section className="s-related"><h3>{detail.type === "SALE_ORDER" ? "Cọc gắn với đơn" : "Khoản tiền gắn với phiếu"}</h3><small>Dữ liệu tiền gần nhất trong phạm vi được cấp, backend hiện giới hạn 1.000 khoản. Cọc tự phân bổ khi phiếu xuất phát sinh nợ.</small><Table headings={["STT", "Ngày", "Loại", "Phương thức", "Tiền", "Đã phân bổ", "Tham chiếu"]}>{payments.map((p, i) => <tr key={text(p, "id")}><td>{i + 1}</td><td>{timestamp(p.created_at)}</td><td>{text(p, "kind") === "RECEIPT" ? "Thu tiền" : text(p, "kind") === "REFUND" ? "Hoàn" : text(p, "kind")}</td><td>{methods[text(p, "method")] ?? text(p, "method")}</td><td>{money(p.amount)}</td><td>{money(p.allocated)}</td><td>{text(p, "reference")}</td></tr>)}</Table>{!payments.length && <p className="s-empty">Chưa có khoản tiền gắn trực tiếp với phiếu này.</p>}</section>}
      {shipmentRows.length > 0 && <section className="s-related"><h3>Đợt giao của phiếu</h3><small>Vận đơn GHN cập nhật qua webhook. Mở tab Giao hàng để tạo vận đơn và xem lịch sử tracking.</small><Table headings={["STT", "Hãng / Vận đơn", "Trạng thái", "COD", "Đã đối soát", "Phí dự kiến / thực tế", "Thao tác"]}>{shipmentRows.map((v, i) => <tr key={text(v, "id")}><td>{i + 1}</td><td>{text(v, "carrier")}<small>{text(v, "tracking")}</small></td><td><Badge value={v.status} delivery /></td><td>{money(v.cod)}</td><td>{money(v.settled)}</td><td>{money(v.fee)} / {money(v.actual_fee)}</td><td>{allowed("delivery", "UPDATE") && text(v, "integration_status") === "MANUAL" && shipmentNext(text(v, "status")).length > 0 && <button onClick={() => openAction("delivery-status", { id: text(v, "id"), version: text(v, "version"), current: text(v, "status"), status: shipmentNext(text(v, "status"))[0] })}>Cập nhật</button>}{can("FINANCE") && ["DELIVERED", "PARTIAL"].includes(text(v, "status")) && num(v, "cod") > num(v, "settled") && <button onClick={() => openAction("cod", { id: text(v, "id"), version: text(v, "version"), amount: String(num(v, "cod") - num(v, "settled")), fee: "0", method: "BANK" })}>Đối soát COD</button>}</td></tr>)}</Table></section>}
    </section>}
    {customerForm && <Dialog quoteComposerOnly={quoteComposerOnly} title="Thêm khách hàng" onClose={() => setCustomerForm(null)} locked={busy}><form onSubmit={e => { e.preventDefault(); void run(quickCustomer); }}><div className="s-dialog-body">{error && <div className="s-alert s-error" role="alert">{error}</div>}<p className="s-muted">Khách hàng được lưu vào danh mục dùng chung và tự chọn cho đơn đang nhập.</p>{[["code", "Mã khách hàng *", 60], ["name", "Tên khách hàng *", 160], ["phone", "Điện thoại", 60], ["email", "Email", 160], ["address", "Địa chỉ", 2000]].map(([key, label, max]) => <Field key={String(key)} label={String(label)}><input autoFocus={key === "name"} required={key === "code" || key === "name"} maxLength={Number(max)} type={key === "email" ? "email" : key === "phone" ? "tel" : "text"} value={customerForm[String(key)]} onChange={e => setCustomerForm(f => f ? { ...f, [String(key)]: e.target.value } : f)} disabled={busy} /></Field>)}<Field label="Loại đối tượng"><select disabled={busy} value={customerForm.entityType} onChange={e => setCustomerForm(f => f ? { ...f, entityType: e.target.value } : f)}><option value="PERSON">Cá nhân</option><option value="BUSINESS">Doanh nghiệp</option></select></Field><Field label="Nhóm khách hàng"><input type="text" value={customerForm.customer_group || "CUSTOMER_SALE"} disabled /></Field><small className="s-muted">Nhóm khách hàng được tự động đặt là CUSTOMER_SALE cho sales tạo mới.</small></div><footer><button type="button" disabled={busy} onClick={() => setCustomerForm(null)}>Đóng</button><button className="s-primary" disabled={busy} type="submit">{busy ? "Đang lưu…" : "Lưu & chọn khách hàng"}</button></footer></form></Dialog>}
    {dialog && detail && <Dialog quoteComposerOnly={quoteComposerOnly} title={({ approve: "Duyệt chứng từ", reject: "Từ chối chứng từ", cancel: "Hủy bản nháp", payment: detail.type === "SALE_ORDER" ? "Báo đã thu tiền cọc" : "Báo đã thu công nợ", delivery: "Tạo đợt giao", "delivery-status": "Cập nhật giao hàng", cod: "Đối soát COD" } as Record<string, string>)[dialog]} onClose={() => setDialog("")} locked={busy}><form onSubmit={e => { e.preventDefault(); void run(action); }}><div className="s-dialog-body">{error && <div className="s-alert s-error" role="alert">{error}</div>}{["approve", "reject", "cancel"].includes(dialog) && actionInput("reason", "Lý do *")}{dialog === "payment" && <>{actionInput("amount", "Số tiền (₫) *", "number")}<Field label="Phương thức"><select value={actionForm.method} onChange={e => setActionForm(f => ({ ...f, method: e.target.value }))}>{Object.entries(methods).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></Field>{actionInput("reference", "Nội dung / Tham chiếu")}<p className="s-muted">Khoản tiền này chỉ được ghi nhận là Sales báo đã thu. Kế toán phải phê duyệt tại màn hình Công nợ trước khi hệ thống lập phiếu thu và giảm công nợ.</p></>}{dialog === "delivery" && <>{actionInput("carrier", "Đơn vị vận chuyển")}{actionInput("tracking", "Mã vận đơn")}{actionInput("cod", "COD dự kiến (₫)", "number")}{actionInput("fee", "Phí hãng dự kiến (₫)", "number")}{actionInput("note", "Ghi chú")}<p className="s-muted">Phí hãng vận chuyển khác phí khách trả trên phiếu bán. Chưa có kết nối hãng vận chuyển.</p></>}{dialog === "delivery-status" && <><Field label="Trạng thái tiếp theo"><select value={actionForm.status} onChange={e => setActionForm(f => ({ ...f, status: e.target.value }))}>{shipmentNext(actionForm.current).map(key => <option key={key} value={key}>{key === "PARTIAL" ? "Giao một phần" : statuses[key]}</option>)}</select></Field>{actionInput("note", "Ghi chú / Lý do")}<small>Giao thất bại không tự hủy đơn hoặc nhập hàng trả.</small></>}{dialog === "cod" && <>{actionInput("amount", "COD gộp (₫) *", "number")}{actionInput("fee", "Phí hãng đối trừ lần này (₫)", "number")}<Field label="Phương thức nhận"><select value={actionForm.method} onChange={e => setActionForm(f => ({ ...f, method: e.target.value }))}>{Object.entries(methods).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></Field><p className="s-muted">Thực nhận dự kiến: {money(Number(actionForm.amount || 0) - Number(actionForm.fee || 0))}. Máy chủ ghi thu COD gộp và chi phí riêng, không ghi doanh thu lần hai.</p></>}</div><footer><ActionButton {...(quoteComposerOnly ? { variant: "outline" as const } : {})} type="button" disabled={busy} onClick={() => setDialog("")}>Đóng</ActionButton><ActionButton type="submit" className={quoteComposerOnly ? undefined : "s-primary"} disabled={busy}>{busy?(dialog==="payment"?"Đang gửi…":"Đang ghi nhận…"):(dialog==="payment"?"Gửi kế toán xác nhận":"Xác nhận")}</ActionButton></footer></form></Dialog>}
  </div>;
}
