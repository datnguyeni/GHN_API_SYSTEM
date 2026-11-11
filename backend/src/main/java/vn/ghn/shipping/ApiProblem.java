package vn.ghn.shipping;

public class ApiProblem extends RuntimeException {
  public final int status;
  public final String code;
  public ApiProblem(int status, String code) { super(code); this.status = status; this.code = code; }
}
