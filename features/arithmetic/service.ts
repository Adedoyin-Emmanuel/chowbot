class ArithmeticService {
  static add(a: number, b: number) {
    return Number(a + b);
  }

  static subtract(a: number, b: number) {
    return a - b;
  }

  static multiply(a: number, b: number) {
    return a * b;
  }

  static divide(a: number, b: number) {
    return a / b;
  }
}

export default ArithmeticService;
