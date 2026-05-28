package android.test

@Retention(AnnotationRetention.RUNTIME)
@Target(AnnotationTarget.FUNCTION)
annotation class RepetitiveTest(val numIterations: Int)
