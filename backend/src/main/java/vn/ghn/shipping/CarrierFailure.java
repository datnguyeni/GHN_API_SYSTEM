package vn.ghn.shipping;

public class CarrierFailure extends RuntimeException {
  public final String code;
  public final boolean unknown;
  public CarrierFailure(String code, boolean unknown) { super(code); this.code=code; this.unknown=unknown; }
}
