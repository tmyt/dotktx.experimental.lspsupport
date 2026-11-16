package constructorfixture

class WithPrimary(val value: Int) {
    constructor(text: String, radix: Int = 10) : this(radix)
    constructor(flag: Boolean) : this(0)
    private constructor(hidden: Double) : this(0)
}

class OnlySecondary {
    val value: Int

    constructor(value: Int) {
        this.value = value
    }

    constructor(text: String) : this(0)
}

class GenericSecondary<T>(val value: T) {
    constructor(values: List<T>) : this(values[0])
}
