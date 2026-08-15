export class WriteCoordinator {
  private readonly tails = new Map<string, Promise<void>>()

  enqueue(
    key: string,
    operation: () => Promise<void>,
    onError: (error: unknown) => void,
  ): void {
    const previous = this.tails.get(key) ?? Promise.resolve()
    const current = previous
      .then(operation)
      .catch((error: unknown) => {
        onError(error)
      })
    this.tails.set(key, current)
    void current.finally(() => {
      if (this.tails.get(key) === current) this.tails.delete(key)
    })
  }

  async wait(key: string): Promise<void> {
    await this.tails.get(key)
  }

  async drain(): Promise<void> {
    while (this.tails.size > 0) {
      await Promise.all([...this.tails.values()])
    }
  }
}
