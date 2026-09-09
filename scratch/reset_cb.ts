import { resetCircuitBreaker, isCircuitBreakerActive } from '../src/db/index';

resetCircuitBreaker();
console.log('Circuit Breaker status after reset:', isCircuitBreakerActive());
